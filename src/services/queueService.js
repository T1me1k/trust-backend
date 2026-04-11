const crypto = require('crypto');
const { query, withTransaction } = require('../db');
const config = require('../config');
const { getCurrentPartyByUserId } = require('./partyService');
const { setPresence } = require('./accountService');

function newPublicMatchId() {
  return `TRUST-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

async function getQueueState(userId) {
  const result = await query(
    `SELECT qe.id, qe.party_id, qe.leader_user_id, qe.mode, qe.status, qe.queued_at, qe.matched_at
     FROM party_members pm
     JOIN queue_entries qe ON qe.party_id = pm.party_id AND qe.status IN ('queued', 'matched')
     JOIN parties p ON p.id = pm.party_id
     WHERE pm.user_id = $1
       AND p.status IN ('searching', 'in_match')
     LIMIT 1`,
    [userId]
  );

  const row = result.rows[0] || null;
  if (!row) return null;

  return {
    id: row.id,
    partyId: row.party_id,
    leaderUserId: row.leader_user_id,
    mode: row.mode,
    status: row.status,
    queuedAt: row.queued_at,
    matchedAt: row.matched_at
  };
}

async function joinQueue(userId, mode = '2x2') {
  const party = await getCurrentPartyByUserId(userId);
  if (!party || !party.id) throw new Error('party_not_found');
  if (party.leader_user_id !== userId) throw new Error('not_party_leader');
  if (party.members.length !== 2) throw new Error('party_size_invalid');
  if (party.status !== 'open') throw new Error('party_not_open');

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO queue_entries (party_id, leader_user_id, mode, status, queued_at)
       VALUES ($1, $2, $3, 'queued', NOW())
       ON CONFLICT (party_id)
       DO UPDATE SET
         leader_user_id = EXCLUDED.leader_user_id,
         mode = EXCLUDED.mode,
         status = 'queued',
         queued_at = NOW(),
         matched_at = NULL`,
      [party.id, userId, mode]
    );

    await client.query(
      `UPDATE parties
       SET status = 'searching', queue_mode = $2, updated_at = NOW()
       WHERE id = $1`,
      [party.id, mode]
    );
  });

  for (const member of party.members) {
    await setPresence(member.userId, 'searching', party.id, null);
  }

  return getQueueState(userId);
}

async function cancelQueue(userId) {
  const party = await getCurrentPartyByUserId(userId);
  if (!party || !party.id) throw new Error('party_not_found');
  if (party.leader_user_id !== userId) throw new Error('not_party_leader');

  await query(
    `UPDATE queue_entries
     SET status = 'cancelled'
     WHERE party_id = $1 AND status IN ('queued', 'matched')`,
    [party.id]
  );

  await query(
    `UPDATE parties
     SET status = 'open', updated_at = NOW()
     WHERE id = $1`,
    [party.id]
  );

  for (const member of party.members) {
    await setPresence(member.userId, 'in_party', party.id, null);
  }

  return true;
}

async function ensureDefaultServer() {
  const result = await query(
    `SELECT *
     FROM server_instances
     WHERE status = 'idle'
     ORDER BY last_heartbeat_at DESC NULLS LAST, name ASC
     LIMIT 1`
  );

  if (result.rows[0]) return result.rows[0];

  const insert = await query(
    `INSERT INTO server_instances (name, host, port, server_password, server_token, status, region, last_heartbeat_at)
     VALUES ('default-local', $1, $2, $3, 'local-dev-token', 'idle', $4, NOW())
     ON CONFLICT (host, port)
     DO UPDATE SET status = 'idle', last_heartbeat_at = NOW()
     RETURNING *`,
    [config.defaultServerIp, config.defaultServerPort, config.defaultServerPassword, config.defaultRegion]
  );

  return insert.rows[0];
}

async function runMatchmakingCycle() {
  const entries = await query(
    `SELECT qe.party_id, qe.leader_user_id, qe.mode, qe.queued_at
     FROM queue_entries qe
     JOIN parties p ON p.id = qe.party_id
     WHERE qe.status = 'queued'
       AND qe.mode = '2x2'
       AND p.status = 'searching'
     ORDER BY qe.queued_at ASC
     LIMIT 2`
  );

  if (entries.rows.length < 2) return null;

  const partyIds = entries.rows.map((row) => row.party_id);
  if (new Set(partyIds).size !== 2) return null;

  const parties = [];
  for (const partyId of partyIds) {
    const members = await query(
      `SELECT pm.user_id, pm.role
       FROM party_members pm
       WHERE pm.party_id = $1
       ORDER BY CASE WHEN pm.role = 'leader' THEN 0 ELSE 1 END, pm.joined_at ASC`,
      [partyId]
    );

    if (members.rows.length !== 2) return null;
    parties.push({ partyId, members: members.rows });
  }

  const server = await ensureDefaultServer();
  const publicMatchId = newPublicMatchId();

  const match = await withTransaction(async (client) => {
    await client.query(
      `UPDATE server_instances
       SET status = 'reserved', last_heartbeat_at = NOW()
       WHERE id = $1`,
      [server.id]
    );

    const matchResult = await client.query(
      `INSERT INTO matches (public_match_id, mode, status, server_id, server_ip, server_port, server_password, map_name, created_at, started_at)
       VALUES ($1, '2x2', 'server_assigned', $2, $3, $4, $5, 'de_dust2', NOW(), NOW())
       RETURNING *`,
      [publicMatchId, server.id, server.host, server.port, server.server_password]
    );

    const row = matchResult.rows[0];

    let slot = 0;
    for (const member of parties[0].members) {
      await client.query(
        `INSERT INTO match_players (match_id, user_id, party_id, team, slot_index, connected_at)
         VALUES ($1, $2, $3, 'A', $4, NOW())`,
        [row.id, member.user_id, parties[0].partyId, slot++]
      );
    }

    slot = 0;
    for (const member of parties[1].members) {
      await client.query(
        `INSERT INTO match_players (match_id, user_id, party_id, team, slot_index, connected_at)
         VALUES ($1, $2, $3, 'B', $4, NOW())`,
        [row.id, member.user_id, parties[1].partyId, slot++]
      );
    }

    for (const partyId of partyIds) {
      await client.query(
        `UPDATE queue_entries
         SET status = 'matched', matched_at = NOW()
         WHERE party_id = $1`,
        [partyId]
      );

      await client.query(
        `UPDATE parties
         SET status = 'in_match', updated_at = NOW()
         WHERE id = $1`,
        [partyId]
      );
    }

    return row;
  });

  for (const member of [...parties[0].members, ...parties[1].members]) {
    await setPresence(member.user_id, 'in_match', null, match.id);
  }

  return match;
}

module.exports = {
  getQueueState,
  joinQueue,
  cancelQueue,
  runMatchmakingCycle
};
