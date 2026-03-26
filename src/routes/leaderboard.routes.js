const express = require('express');
const { ok } = require('../utils/http');
const { query } = require('../db');

const router = express.Router();

router.get('/', async (req, res) => {
  const itemsResult = await query(
    `SELECT u.persona_name, u.avatar_full_url, p.elo_2v2,
            ROW_NUMBER() OVER (ORDER BY p.elo_2v2 DESC, p.wins_2v2 DESC, u.persona_name ASC) AS rank
     FROM player_profiles p
     JOIN users u ON u.id = p.user_id
     ORDER BY p.elo_2v2 DESC, p.wins_2v2 DESC, u.persona_name ASC
     LIMIT 50`
  );
  return ok(res, { items: itemsResult.rows });
});

module.exports = router;
