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
      steamId: account.steam_id,
      steamId64: account.steam_id,
      nickname: account.persona_name,
      avatarUrl: account.avatar_full_url || account.avatar_medium_url || account.avatar_url || null,
      profileUrl: account.profile_url || null,
      elo2v2: Number(account.elo_2v2 || 100),
      wins2v2: Number(account.wins_2v2 || 0),
      losses2v2: Number(account.losses_2v2 || 0),
      matchesPlayed2v2: Number(account.matches_played_2v2 || 0),
      presence: account.presence || 'online'
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
      elo2v2: Number(account.elo_2v2 || 100),
      wins2v2: Number(account.wins_2v2 || 0),
      losses2v2: Number(account.losses_2v2 || 0),
      matchesPlayed2v2: Number(account.matches_played_2v2 || 0)
    }
  });
});

router.get('/users/search', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return fail(res, 400, 'missing_query');
  const items = await searchUsersByNickname(q, req.session.userId);
  return ok(res, {
    items: items.map((item) => ({
      id: item.id,
      steamId: item.steam_id,
      steamId64: item.steam_id,
      nickname: item.persona_name,
      avatarUrl: item.avatar_full_url || null,
      elo2v2: Number(item.elo_2v2 || 100),
      partyStatus: item.party_status || null,
      presence: item.presence_state || 'online',
      presenceLabel: item.presence_state === 'searching' ? 'Уже ищет матч' : item.party_status ? 'Уже в lobby' : 'Онлайн'
    }))
  });
});

module.exports = router;
