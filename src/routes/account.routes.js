const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { ok, fail } = require('../utils/http');
const { getAccountByUserId, getHistoryByUserId, searchUsersByNickname } = require('../services/accountService');

const router = express.Router();

router.get('/me', requireAuth, async (req, res) => {
  const account = await getAccountByUserId(req.session.userId);
  return ok(res, {
    user: {
      id: account.id,
      steamId64: account.steam_id,
      nickname: account.persona_name,
      avatarUrl: account.avatar_full_url,
      elo2v2: account.elo_2v2,
      wins2v2: account.wins_2v2,
      losses2v2: account.losses_2v2,
      matchesPlayed2v2: account.matches_played_2v2,
      presence: account.presence
    }
  });
});

router.get('/me/history', requireAuth, async (req, res) => {
  const items = await getHistoryByUserId(req.session.userId, Number(req.query.limit || 8));
  return ok(res, { items });
});

router.get('/me/stats', requireAuth, async (req, res) => {
  const account = await getAccountByUserId(req.session.userId);
  return ok(res, {
    stats: {
      elo2v2: account.elo_2v2,
      wins2v2: account.wins_2v2,
      losses2v2: account.losses_2v2,
      matchesPlayed2v2: account.matches_played_2v2
    }
  });
});

router.get('/users/search', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return fail(res, 400, 'missing_query');
  const items = await searchUsersByNickname(q);
  return ok(res, { items });
});

module.exports = router;
