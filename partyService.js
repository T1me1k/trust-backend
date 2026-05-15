const { query } = require('../db');

async function ensurePlayerProfile(userId) {
  await query(
    `INSERT INTO player_profiles (
       user_id,
       elo_2v2,
       wins_2v2,
       losses_2v2,
       matches_played_2v2,
       updated_at
     )
     VALUES ($1, 100, 0, 0, 0, NOW())
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
}

async function setPresence(userId, state, currentPartyId = null, currentMatchId = null) {
  await query(
    `INSERT INTO presence (
       user_id,
       state,
       current_party_id,
       current_match_id,
       updated_at
     )
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET
       state = EXCLUDED.state,
       current_party_id = EXCLUDED.current_party_id,
       current_match_id = EXCLUDED.current_match_id,
       updated_at = NOW()`,
    [userId, state, currentPartyId, currentMatchId]
  );
}

async function getAccountByUserId(userId) {
  await ensurePlayerProfile(userId);

  const result = await query(
    `SELECT
        u.id,
        u.steam_id,
        u.persona_name,
        u.profile_url,
        u.avatar_url,
        u.avatar_medium_url,
        u.avatar_full_url,
        p.elo_2v2,
        p.wins_2v2,
        p.losses_2v2,
        p.matches_played_2v2,
        COALESCE(pr.state, 'online') AS presence
     FROM users u
     JOIN player_profiles p
       ON p.user_id = u.id
     LEFT JOIN presence pr
       ON pr.user_id = u.id
     WHERE u.id = $1
     LIMIT 1`,
    [userId]
  );

  return result.rows[0] || null;
}

async function searchUsersByNickname(q, currentUserId = null) {
  const params = [`%${q}%`];
  let exclusionSql = '';
  if (currentUserId) {
    params.push(currentUserId);
    exclusionSql = ` AND u.id <> $${params.length}`;
  }

  const result = await query(
    `SELECT
        u.id,
        u.steam_id,
        u.persona_name,
        u.avatar_full_url,
        COALESCE(p.elo_2v2, 100) AS elo_2v2,
        COALESCE(pr.state, 'online') AS presence_state,
        ap.status AS party_status
     FROM users u
     LEFT JOIN player_profiles p
       ON p.user_id = u.id
     LEFT JOIN presence pr
       ON pr.user_id = u.id
     LEFT JOIN LATERAL (
       SELECT p2.status
       FROM party_members pm2
       JOIN parties p2 ON p2.id = pm2.party_id
       WHERE pm2.user_id = u.id AND p2.status <> 'closed'
       ORDER BY p2.created_at DESC
       LIMIT 1
     ) ap ON TRUE
     WHERE LOWER(u.persona_name) LIKE LOWER($1)${exclusionSql}
     ORDER BY u.persona_name ASC
     LIMIT 10`,
    params
  );

  return result.rows;
}

async function getHistoryByUserId(userId, limit = 8) {
  const result = await query(
    `SELECT
        m.public_match_id,
        m.map_name,
        m.team_a_score,
        m.team_b_score,
        m.winner_team,
        m.finished_at,
        mp.team,
        mp.elo_before,
        mp.elo_after,
        mp.elo_delta,
        mp.result
     FROM match_players mp
     JOIN matches m
       ON m.id = mp.match_id
     WHERE mp.user_id = $1
       AND m.status = 'finished'
     ORDER BY m.finished_at DESC NULLS LAST, m.created_at DESC
     LIMIT $2`,
    [userId, limit]
  );

  return result.rows;
}

module.exports = {
  ensurePlayerProfile,
  setPresence,
  getAccountByUserId,
  searchUsersByNickname,
  getHistoryByUserId
};
