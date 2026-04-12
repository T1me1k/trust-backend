const { query, withTransaction } = require('../db');
const { applySimpleMatchElo } = require('./eloService');
const { setPresence } = require('./accountService');

async function getCurrentMatchByUserId(userId) {
  const result = await query(
    `SELECT m.id, m.public_match_id, m.mode, m.status, m.map_name, m.server_ip, m.server_port, m.server_password,
            m.team_a_score, m.team_b_score, m.winner_team, mp.team
     FROM match_players mp
     JOIN matches m ON m.id = mp.match_id
     WHERE mp.user_id = $1 AND m.status IN ('pending', 'server_assigned', 'live')
     ORDER BY m.created_at DESC
     LIMIT 1`,
    [userId]
  );
  const match = result.rows[0] || null;
  if (!match) return null;

  const players = await query(
    `SELECT u.persona_name AS nickname, u.avatar_full_url AS avatar_url, p.elo_2v2, mp.team, mp.slot_index
     FROM match_players mp
     JOIN users u ON u.id = mp.user_id
     LEFT JOIN player_profiles p ON p.user_id = u.id
     WHERE mp.match_id = $1
     ORDER BY mp.team, mp.slot_index`,
    [match.id]
  );

  return {
    matchId: match.public_match_id,
    publicMatchId: match.public_match_id,
    mode: match.mode,
    status: match.status,
    mapName: match.map_name,
    serverIp: match.server_ip,
    serverPort: match.server_port,
    serverPassword: match.server_password,
    teamAScore: Number(match.team_a_score || 0),
    teamBScore: Number(match.team_b_score || 0),
    winnerTeam: match.winner_team,
    team: match.team,
    players: players.rows.map((row) => ({
      nickname: row.nickname,
      avatarUrl: row.avatar_url || null,
      elo: Number(row.elo_2v2 || 100),
      team: row.team,
      slotIndex: row.slot_index
    }))
  };
}

async function getMatchHistory(userId, limit = 8) {
  const result = await query(
    `SELECT m.public_match_id, m.mode, m.status, m.map_name, m.team_a_score, m.team_b_score, m.winner_team, m.finished_at,
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

async function submitMatchResult({ publicMatchId, winnerTeam, teamAScore, teamBScore, mapName, resultSource = 'server_plugin' }) {
  const matchResult = await query(
    `SELECT id, status, server_id FROM matches WHERE public_match_id = $1 LIMIT 1`,
    [publicMatchId]
  );
  const match = matchResult.rows[0];
  if (!match) throw new Error('match_not_found');
  if (match.status === 'finished') return { alreadyFinished: true };

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE matches
       SET status = 'finished', winner_team = $2, team_a_score = $3, team_b_score = $4,
           map_name = COALESCE($5, map_name), result_source = $6, finished_at = NOW()
       WHERE id = $1`,
      [match.id, winnerTeam, teamAScore, teamBScore, mapName || null, resultSource]
    );

    if (match.server_id) {
      await client.query(
        `UPDATE server_instances
         SET status = 'idle', last_heartbeat_at = NOW()
         WHERE id = $1`,
        [match.server_id]
      );
    }
  });

  await applySimpleMatchElo(match.id, winnerTeam);

  const players = await query(`SELECT user_id, party_id FROM match_players WHERE match_id = $1`, [match.id]);
  const touchedPartyIds = new Set();
  for (const row of players.rows) {
    if (row.party_id) touchedPartyIds.add(row.party_id);
  }

  for (const row of players.rows) {
    const nextPartyId = row.party_id || null;
    const nextState = nextPartyId ? 'in_party' : 'online';
    await setPresence(row.user_id, nextState, nextPartyId, null);
  }

  for (const partyId of touchedPartyIds) {
    await query(`UPDATE parties SET status = 'open', updated_at = NOW() WHERE id = $1`, [partyId]);
    await query(`UPDATE queue_entries SET status = 'cancelled' WHERE party_id = $1 AND status <> 'cancelled'`, [partyId]);
  }

  return { alreadyFinished: false };
}

module.exports = {
  getCurrentMatchByUserId,
  getMatchHistory,
  submitMatchResult
};
