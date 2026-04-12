const { query, withTransaction } = require('../db');
const { setPresence } = require('./accountService');

function normalizeMember(row) {
  return {
    userId: row.user_id,
    role: row.role,
    nickname: row.persona_name,
    avatarUrl: row.avatar_full_url || null,
    elo2v2: Number(row.elo_2v2 || 100)
  };
}

function normalizeInvite(row) {
  return {
    id: row.id,
    partyId: row.party_id,
    fromUserId: row.from_user_id,
    toUserId: row.to_user_id,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    fromNickname: row.from_nickname,
    fromAvatarUrl: row.from_avatar_url || null
  };
}

async function getIncomingInvitesByUserId(userId) {
  const result = await query(
    `SELECT
        pi.id,
        pi.party_id,
        pi.from_user_id,
        pi.to_user_id,
        pi.status,
        pi.created_at,
        pi.expires_at,
        u.persona_name AS from_nickname,
        u.avatar_full_url AS from_avatar_url
     FROM party_invites pi
     JOIN users u ON u.id = pi.from_user_id
     WHERE pi.to_user_id = $1
       AND pi.status = 'pending'
       AND pi.expires_at > NOW()
     ORDER BY pi.created_at DESC`,
    [userId]
  );

  return result.rows.map(normalizeInvite);
}

async function getCurrentPartyByUserId(userId) {
  const partyResult = await query(
    `SELECT p.*
     FROM party_members pm
     JOIN parties p ON p.id = pm.party_id
     WHERE pm.user_id = $1
       AND p.status <> 'closed'
     ORDER BY p.created_at DESC
     LIMIT 1`,
    [userId]
  );

  const party = partyResult.rows[0] || null;
  const incomingInvites = await getIncomingInvitesByUserId(userId);

  if (!party) {
    return {
      id: null,
      isLeader: false,
      status: null,
      queueMode: null,
      leader_user_id: null,
      members: [],
      pendingInvites: incomingInvites
    };
  }

  const membersResult = await query(
    `SELECT
        pm.user_id,
        pm.role,
        u.persona_name,
        u.avatar_full_url,
        pprof.elo_2v2
     FROM party_members pm
     JOIN users u ON u.id = pm.user_id
     LEFT JOIN player_profiles pprof ON pprof.user_id = u.id
     WHERE pm.party_id = $1
     ORDER BY CASE WHEN pm.role = 'leader' THEN 0 ELSE 1 END, pm.joined_at ASC`,
    [party.id]
  );

  return {
    ...party,
    queueMode: party.queue_mode || '2x2',
    isLeader: party.leader_user_id === userId,
    members: membersResult.rows.map(normalizeMember),
    pendingInvites: incomingInvites
  };
}

async function createParty(userId) {
  const existing = await getCurrentPartyByUserId(userId);
  if (existing && existing.id) return existing;

  const party = await withTransaction(async (client) => {
    const partyResult = await client.query(
      `INSERT INTO parties (leader_user_id, status, queue_mode, created_at, updated_at)
       VALUES ($1, 'open', '2x2', NOW(), NOW())
       RETURNING *`,
      [userId]
    );

    const row = partyResult.rows[0];

    await client.query(
      `INSERT INTO party_members (party_id, user_id, role, joined_at)
       VALUES ($1, $2, 'leader', NOW())
       ON CONFLICT (party_id, user_id) DO NOTHING`,
      [row.id, userId]
    );

    return row;
  });

  await setPresence(userId, 'in_party', party.id, null);
  return getCurrentPartyByUserId(userId);
}

async function inviteToParty({ actorUserId, targetUserId }) {
  const party = await getCurrentPartyByUserId(actorUserId);
  if (!party || !party.id) throw new Error('party_not_found');
  if (party.leader_user_id !== actorUserId) throw new Error('not_party_leader');
  if (party.status !== 'open') throw new Error('party_not_open');
  if (targetUserId === actorUserId) throw new Error('cannot_invite_self');
  if (party.members.length >= 2) throw new Error('party_full');

  const targetParty = await getCurrentPartyByUserId(targetUserId);
  if (targetParty && targetParty.id) throw new Error('target_already_in_party');

  const existingInvite = await query(
    `SELECT id
     FROM party_invites
     WHERE party_id = $1
       AND to_user_id = $2
       AND status = 'pending'
       AND expires_at > NOW()
     LIMIT 1`,
    [party.id, targetUserId]
  );

  if (existingInvite.rows[0]) throw new Error('invite_already_sent');

  const result = await query(
    `INSERT INTO party_invites (party_id, from_user_id, to_user_id, status, created_at, expires_at)
     VALUES ($1, $2, $3, 'pending', NOW(), NOW() + INTERVAL '15 minutes')
     RETURNING *`,
    [party.id, actorUserId, targetUserId]
  );

  return result.rows[0];
}

async function acceptInvite(inviteId, userId) {
  return withTransaction(async (client) => {
    const inviteResult = await client.query(
      `SELECT *
       FROM party_invites
       WHERE id = $1
       LIMIT 1
       FOR UPDATE`,
      [inviteId]
    );

    const invite = inviteResult.rows[0];
    if (!invite) throw new Error('invite_not_found');
    if (invite.to_user_id !== userId) throw new Error('forbidden');
    if (invite.status !== 'pending') throw new Error('invite_not_pending');
    if (new Date(invite.expires_at) < new Date()) throw new Error('invite_expired');

    const activeParty = await client.query(
      `SELECT pm.party_id
       FROM party_members pm
       JOIN parties p ON p.id = pm.party_id
       WHERE pm.user_id = $1
         AND p.status <> 'closed'
       LIMIT 1`,
      [userId]
    );

    if (activeParty.rows[0]) throw new Error('already_in_party');

    const membersCount = await client.query(
      `SELECT COUNT(*)::int AS c
       FROM party_members
       WHERE party_id = $1`,
      [invite.party_id]
    );

    if (membersCount.rows[0].c >= 2) throw new Error('party_full');

    await client.query(
      `UPDATE party_invites
       SET status = 'accepted'
       WHERE id = $1`,
      [inviteId]
    );

    await client.query(
      `INSERT INTO party_members (party_id, user_id, role, joined_at)
       VALUES ($1, $2, 'member', NOW())`,
      [invite.party_id, userId]
    );

    return invite.party_id;
  });
}

async function declineInvite(inviteId, userId) {
  const result = await query(
    `UPDATE party_invites
     SET status = 'declined'
     WHERE id = $1
       AND to_user_id = $2
       AND status = 'pending'
     RETURNING id`,
    [inviteId, userId]
  );

  return !!result.rows[0];
}

async function leaveParty(userId) {
  const party = await getCurrentPartyByUserId(userId);
  if (!party || !party.id) return null;

  await withTransaction(async (client) => {
    await client.query(
      `DELETE FROM party_members
       WHERE party_id = $1 AND user_id = $2`,
      [party.id, userId]
    );

    const members = await client.query(
      `SELECT user_id
       FROM party_members
       WHERE party_id = $1
       ORDER BY joined_at ASC`,
      [party.id]
    );

    if (members.rows.length === 0) {
      await client.query(
        `UPDATE parties
         SET status = 'closed', updated_at = NOW()
         WHERE id = $1`,
        [party.id]
      );

      await client.query(
        `UPDATE queue_entries
         SET status = 'cancelled'
         WHERE party_id = $1 AND status = 'queued'`,
        [party.id]
      );

      await client.query(
        `UPDATE party_invites
         SET status = 'cancelled'
         WHERE party_id = $1 AND status = 'pending'`,
        [party.id]
      );

      return;
    }

    if (party.leader_user_id === userId) {
      const newLeaderId = members.rows[0].user_id;

      await client.query(
        `UPDATE parties
         SET leader_user_id = $2, updated_at = NOW()
         WHERE id = $1`,
        [party.id, newLeaderId]
      );

      await client.query(
        `UPDATE party_members
         SET role = CASE WHEN user_id = $2 THEN 'leader' ELSE 'member' END
         WHERE party_id = $1`,
        [party.id, newLeaderId]
      );
    }
  });

  await setPresence(userId, 'online', null, null);
  return true;
}

async function disbandParty(userId) {
  const party = await getCurrentPartyByUserId(userId);
  if (!party || !party.id) return false;
  if (party.leader_user_id !== userId) throw new Error('not_party_leader');

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE parties
       SET status = 'closed', updated_at = NOW()
       WHERE id = $1`,
      [party.id]
    );

    await client.query(
      `DELETE FROM party_members
       WHERE party_id = $1`,
      [party.id]
    );

    await client.query(
      `UPDATE queue_entries
       SET status = 'cancelled'
       WHERE party_id = $1 AND status = 'queued'`,
      [party.id]
    );

    await client.query(
      `UPDATE party_invites
       SET status = 'cancelled'
       WHERE party_id = $1 AND status = 'pending'`,
      [party.id]
    );
  });

  for (const member of party.members) {
    await setPresence(member.userId, 'online', null, null);
  }

  return true;
}

module.exports = {
  getCurrentPartyByUserId,
  getIncomingInvitesByUserId,
  createParty,
  inviteToParty,
  acceptInvite,
  declineInvite,
  leaveParty,
  disbandParty
};
