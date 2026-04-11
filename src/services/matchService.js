const { query, withTransaction } = require('../db');
const { applySimpleMatchElo } = require('./eloService');
const { setPresence } = require('./accountService');

function normalizeWinnerTeam(value) {
  if (!value) return null;
  const v = String(value).toUpperCase();
  if (v === 'A' || v === 'CT') return 'A';
  if (v === 'B' || v === 'T') return 'B';
  return null;
}

async function getCurrentMatchByUserId(userId) {
  const result = await query(
    `SELECT m.id, m.public_match_id, m.status, m.map_name, m.server_ip, m.server_port, m.server_password,
            m.team_a_score, m.team_b_score, m.winner_team, mp.team
     FROM match_players mp
     JOIN matches m ON m.id = mp.match_id
     WHERE mp.user_id = $1 AND m.status IN ('pending','server_assigned','live')
     ORDER BY m.created_at DESC
     LIMIT 1`,
    [userId]
  );
  const match = result.rows[0] || null;
  if (!match) return null;

  const players = await query(
    `SELECT u.persona_name, u.avatar_full_url, p.elo_2v2, mp.team, mp.slot_index
     FROM match_players mp
     JOIN users u ON u.id = mp.user_id
     LEFT JOIN player_profiles p ON p.user_id = u.id
     WHERE mp.match_id = $1
     ORDER BY mp.team, mp.slot_index`,
    [match.id]
  );

  return { ...match, players: players.rows };
}

async function getMatchHistory(userId, limit = 8) {
  const result = await query(
    `SELECT m.public_match_id, m.status, m.map_name, m.team_a_score, m.team_b_score, m.winner_team, m.finished_at,
            mp.team, mp.elo_before, mp.elo_after, mp.elo_delta, mp.result
     FROM match_players mp
     JOIN matches m ON m.id = mp.match_id
     WHERE mp.user_id = $1 AND m.status = 'finished'
     ORDER BY m.finished_at DESC NULLS LAST, m.created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return result.rows;
}

async function getServerByToken(serverToken) {
  if (!serverToken) return null;
  const result = await query(`SELECT * FROM server_instances WHERE server_token = $1 LIMIT 1`, [serverToken]);
  return result.rows[0] || null;
}

async function heartbeatServer(serverToken, patch = {}) {
  const server = await getServerByToken(serverToken);
  if (!server) throw new Error('server_not_found');

  const nextStatus = ['idle', 'reserved', 'live', 'offline'].includes(patch.status)
    ? patch.status
    : server.status;

  const result = await query(
    `UPDATE server_instances
     SET status = $2,
         name = COALESCE($3, name),
         host = COALESCE($4, host),
         port = COALESCE($5, port),
         last_heartbeat_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [server.id, nextStatus, patch.name || null, patch.host || null, patch.port || null]
  );

  return result.rows[0];
}

async function getAssignedMatchForServer(serverToken) {
  const server = await getServerByToken(serverToken);
  if (!server) throw new Error('server_not_found');

  const matchResult = await query(
    `SELECT m.*
     FROM matches m
     WHERE m.server_id = $1
       AND m.status IN ('server_assigned', 'live')
     ORDER BY m.created_at DESC
     LIMIT 1`,
    [server.id]
  );
  const match = matchResult.rows[0] || null;
  if (!match) return null;

  const playersResult = await query(
    `SELECT mp.team, mp.slot_index, u.steam_id, u.persona_name, u.avatar_full_url
     FROM match_players mp
     JOIN users u ON u.id = mp.user_id
     WHERE mp.match_id = $1
     ORDER BY mp.team ASC, mp.slot_index ASC`,
    [match.id]
  );

  const players = playersResult.rows.map((row) => ({
    team: row.team,
    slotIndex: row.slot_index,
    steamId64: row.steam_id,
    nickname: row.persona_name,
    avatarUrl: row.avatar_full_url || null
  }));

  return {
    matchId: match.public_match_id,
    status: match.status,
    map: match.map_name,
    serverIp: match.server_ip,
    serverPort: match.server_port,
    serverPassword: match.server_password,
    teamAName: 'Team A',
    teamBName: 'Team B',
    players
  };
}

async function markMatchLiveForServer(serverToken, publicMatchId) {
  const server = await getServerByToken(serverToken);
  if (!server) throw new Error('server_not_found');

  const result = await query(
    `UPDATE matches
     SET status = 'live'
     WHERE public_match_id = $1
       AND server_id = $2
       AND status IN ('server_assigned', 'live')
     RETURNING id, public_match_id, status`,
    [publicMatchId, server.id]
  );

  const match = result.rows[0];
  if (!match) throw new Error('match_not_found');

  await query(`UPDATE server_instances SET status = 'live', last_heartbeat_at = NOW() WHERE id = $1`, [server.id]);
  return match;
}

async function submitMatchResult({ publicMatchId, winnerTeam, teamAScore, teamBScore, mapName, resultSource = 'server_plugin', serverToken = null }) {
  const normalizedWinner = normalizeWinnerTeam(winnerTeam);
  if (!normalizedWinner) throw new Error('winner_team_invalid');

  let scopedServer = null;
  if (serverToken) {
    scopedServer = await getServerByToken(serverToken);
    if (!scopedServer) throw new Error('server_not_found');
  }

  const matchResult = await query(`SELECT id, status, server_id FROM matches WHERE public_match_id = $1 LIMIT 1`, [publicMatchId]);
  const match = matchResult.rows[0];
  if (!match) throw new Error('match_not_found');
  if (scopedServer && match.server_id !== scopedServer.id) throw new Error('server_match_mismatch');
  if (match.status === 'finished') return { alreadyFinished: true };

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE matches
       SET status = 'finished', winner_team = $2, team_a_score = $3, team_b_score = $4,
           map_name = COALESCE($5, map_name), result_source = $6, finished_at = NOW()
       WHERE id = $1`,
      [match.id, normalizedWinner, teamAScore, teamBScore, mapName || null, resultSource]
    );
  });

  await applySimpleMatchElo(match.id, normalizedWinner);

  const players = await query(`SELECT user_id, party_id FROM match_players WHERE match_id = $1`, [match.id]);
  const touchedPartyIds = new Set();
  for (const row of players.rows) {
    await setPresence(row.user_id, 'online', null, null);
    if (row.party_id) touchedPartyIds.add(row.party_id);
  }
  for (const partyId of touchedPartyIds) {
    await query(`UPDATE parties SET status = 'open', updated_at = NOW() WHERE id = $1`, [partyId]);
  }

  await query(`UPDATE server_instances SET status = 'idle', last_heartbeat_at = NOW() WHERE id = $1`, [match.server_id]);
  return { alreadyFinished: false };
}

module.exports = {
  getCurrentMatchByUserId,
  getMatchHistory,
  getServerByToken,
  heartbeatServer,
  getAssignedMatchForServer,
  markMatchLiveForServer,
  submitMatchResult
};
