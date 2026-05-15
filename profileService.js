const { withTransaction } = require('../db');

async function applySimpleMatchElo(matchDbId, winnerTeam) {
  return withTransaction(async (client) => {
    const playersResult = await client.query(
      `SELECT mp.user_id, mp.team, p.elo_2v2
       FROM match_players mp
       JOIN player_profiles p ON p.user_id = mp.user_id
       WHERE mp.match_id = $1
       ORDER BY mp.team, mp.slot_index`,
      [matchDbId]
    );

    for (const row of playersResult.rows) {
      const isWinner = row.team === winnerTeam;
      const before = row.elo_2v2;
      const delta = isWinner ? 25 : -25;
      const after = before + delta;
      const result = isWinner ? 'win' : 'loss';

      await client.query(
        `UPDATE match_players
         SET elo_before = $2, elo_after = $3, elo_delta = $4, result = $5
         WHERE match_id = $1 AND user_id = $6`,
        [matchDbId, before, after, delta, result, row.user_id]
      );

      await client.query(
        `UPDATE player_profiles
         SET elo_2v2 = $2,
             wins_2v2 = wins_2v2 + CASE WHEN $3 = 'win' THEN 1 ELSE 0 END,
             losses_2v2 = losses_2v2 + CASE WHEN $3 = 'loss' THEN 1 ELSE 0 END,
             matches_played_2v2 = matches_played_2v2 + 1,
             updated_at = NOW(),
             last_match_at = NOW()
         WHERE user_id = $1`,
        [row.user_id, after, result]
      );
    }
  });
}

module.exports = { applySimpleMatchElo };
