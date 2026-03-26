const express = require('express');
const { ok } = require('../utils/http');
const { query } = require('../db');

const router = express.Router();

router.get('/', async (req, res) => {
  const itemsResult = await query(
    `SELECT u.id, u.steam_id, u.persona_name, u.avatar_full_url, p.elo_2v2,
            ROW_NUMBER() OVER (ORDER BY p.elo_2v2 DESC, p.wins_2v2 DESC, u.persona_name ASC) AS rank
     FROM player_profiles p
     JOIN users u ON u.id = p.user_id
     ORDER BY p.elo_2v2 DESC, p.wins_2v2 DESC, u.persona_name ASC
     LIMIT 50`
  );

  return ok(res, {
    items: itemsResult.rows.map((row) => ({
      rank: Number(row.rank),
      id: row.id,
      steamId: row.steam_id,
      steamId64: row.steam_id,
      nickname: row.persona_name,
      avatarUrl: row.avatar_full_url || null,
      elo2v2: Number(row.elo_2v2 || 100)
    }))
  });
});

module.exports = router;
