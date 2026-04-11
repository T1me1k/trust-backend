const crypto = require('crypto');
const config = require('../config');
const { query, withTransaction } = require('../db');
const { getCurrentPartyByUserId } = require('./partyService');
const { setPresence } = require('./accountService');

function newPublicMatchId() {
  return 'match_' + crypto.randomBytes(8).toString('hex');
}

async function getQueueState(userId) {
  const result = await query(
    `SELECT qe.*, p.id AS party_id
     FROM party_members pm
     JOIN queue_entries qe ON qe.party_id = pm.party_id AND qe.status = 'queued'
     JOIN parties p ON p.id = pm.party_id
     WHERE pm.user_id = $1
     LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

async function joinQueue(userId, mode = '2x2') {
  const party = await getCurrentPartyByUserId(userId);
  if (!party) throw new Error('party_not_found');
  if (party.leader_user_id !== userId) throw new Error('not_party_leader');
  if (party.members.length !== 2) throw new Error('party_size_invalid');
  if (party.status !== 'open') throw new Error('party_not_open');

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO queue_entries (party_id, leader_user_id, mode, status, queued_at)
       VALUES ($1,$2,$3,'queued',NOW())
       ON CONFLICT (party_id)
       DO UPDATE SET leader_user_id = EXCLUDED.leader_user_id, mode = EXCLUDED.mode, status = 'queued', queued_at = NOW(), matched_at = NULL`,
      [party.id, userId, mode]
    );
    await client.query(`UPDATE parties SET status = 'searching', updated_at = NOW() WHERE id = $1`, [party.id]);
  });

  for (const member of party.members) {
    await setPresence(member.user_id, 'searching', party.id, null);
  }

  return getQueueState(userId);
}

async function cancelQueue(userId) {
  const party = await getCurrentPartyByUserId(userId);
  if (!party) throw new Error('party_not_found');
  if (party.leader_user_id !== userId) throw new Error('not_party_leader');

  await query(`UPDATE queue_entries SET status = 'cancelled' WHERE party_id = $1 AND status = 'queued'`, [party.id]);
  await query(`UPDATE parties SET status = 'open', updated_at = NOW() WHERE id = $1`, [party.id]);
  for (const member of party.members) {
    await setPresence(member.user_id, 'in_party', party.id, null);
  }
  return true;
}

async function ensureDefaultServer() {
  const result = await query(`SELECT * FROM server_instances WHERE status = 'idle' ORDER BY last_heartbeat_at DESC NULLS LAST, name ASC LIMIT 1`);
  if (result.rows[0]) return result.rows[0];

  const insert = await query(
    `INSERT INTO server_instances (name, host, port, server_password, server_token, status, region, last_heartbeat_at)
     VALUES ('default-local', $1, $2, $3, 'local-dev-token', 'idle', $4, NOW())
     ON CONFLICT (host, port) DO UPDATE SET status = 'idle'
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
     WHERE qe.status = 'queued' AND qe.mode = '2x2' AND p.status = 'searching'
     ORDER BY qe.queued_at ASC
     LIMIT 2`
  );

  if (entries.rows.length < 2) return null;

  const partyIds = entries.rows.map((r) => r.party_id);
  const parties = [];
  for (const partyId of partyIds) {
    const members = await query(
      `SELECT pm.user_id, pm.role
       FROM party_members pm
       WHERE pm.party_id = $1
       ORDER BY CASE WHEN pm.role='leader' THEN 0 ELSE 1 END, pm.joined_at ASC`,
      [partyId]
    );
    if (members.rows.length !== 2) return null;
    parties.push({ partyId, members: members.rows });
  }

  const server = await ensureDefaultServer();
  const publicMatchId = newPublicMatchId();

  const match = await withTransaction(async (client) => {
    await client.query(`UPDATE server_instances SET status = 'reserved', last_heartbeat_at = NOW() WHERE id = $1`, [server.id]);
    const matchResult = await client.query(
      `INSERT INTO matches (public_match_id, mode, status, server_id, server_ip, server_port, server_password, map_name, created_at)
       VALUES ($1,'2x2','server_assigned',$2,$3,$4,$5,'de_dust2',NOW())
       RETURNING *`,
      [publicMatchId, server.id, server.host, server.port, server.server_password]
    );
    const row = matchResult.rows[0];

    let slot = 0;
    for (const member of parties[0].members) {
      await client.query(`INSERT INTO match_players (match_id, user_id, party_id, team, slot_index) VALUES ($1,$2,$3,'A',$4)`, [row.id, member.user_id, parties[0].partyId, slot++]);
    }
    slot = 0;
    for (const member of parties[1].members) {
      await client.query(`INSERT INTO match_players (match_id, user_id, party_id, team, slot_index) VALUES ($1,$2,$3,'B',$4)`, [row.id, member.user_id, parties[1].partyId, slot++]);
    }

    for (const partyId of partyIds) {
      await client.query(`UPDATE queue_entries SET status = 'matched', matched_at = NOW() WHERE party_id = $1`, [partyId]);
      await client.query(`UPDATE parties SET status = 'in_match', updated_at = NOW() WHERE id = $1`, [partyId]);
    }

    return row;
  });

  const allUsers = [...parties[0].members, ...parties[1].members];
  for (const member of allUsers) {
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
