const crypto = require('crypto');
const express = require('express');
const { ok, fail } = require('../utils/http');
const { ensurePlayerProfile, setPresence, getAccountByUserId } = require('../services/accountService');
const {
  buildSteamLoginUrl,
  verifySteamOpenId,
  fetchSteamProfile,
  upsertUserFromSteam,
  createSteamLoginState,
  validateSteamLoginState
} = require('../services/steamService');
const config = require('../config');
const { createAuthToken } = require('../utils/authToken');
const { resolveAuthUserId } = require('../middleware/auth');

const router = express.Router();
const loginExchangeStore = new Map();
const LOGIN_EXCHANGE_TTL_MS = 1000 * 60 * 5;

function normalizeBase(value) {
  return String(value || '').replace(/\/+$/, '');
}

function getDefaultReturnUrl() {
  return `${normalizeBase(config.publicSiteUrl)}/app.html`;
}

function sanitizeReturnTo(rawValue) {
  const fallback = getDefaultReturnUrl();
  if (typeof rawValue !== 'string' || !rawValue.trim()) return fallback;

  try {
    const requested = new URL(rawValue.trim());
    const publicSiteOrigin = new URL(normalizeBase(config.publicSiteUrl)).origin;
    if (requested.origin !== publicSiteOrigin) return fallback;
    return requested.toString();
  } catch (_) {
    return fallback;
  }
}

function createLoginExchange(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  loginExchangeStore.set(token, {
    userId: Number(userId),
    expiresAt: Date.now() + LOGIN_EXCHANGE_TTL_MS
  });
  return token;
}

function consumeLoginExchange(token) {
  if (!token || typeof token !== 'string') return null;
  const item = loginExchangeStore.get(token);
  if (!item) return null;
  loginExchangeStore.delete(token);
  if (!item.userId || item.expiresAt < Date.now()) return null;
  return item;
}

function cleanupLoginExchanges() {
  const now = Date.now();
  for (const [token, item] of loginExchangeStore.entries()) {
    if (!item || item.expiresAt < now) loginExchangeStore.delete(token);
  }
}

function appendExchangeToReturnUrl(returnTo, exchange) {
  const url = new URL(returnTo);
  url.searchParams.set('steam_login', '1');
  url.searchParams.set('auth_exchange', exchange);
  return url.toString();
}

router.get('/me', async (req, res) => {
  try {
    const authUserId = resolveAuthUserId(req);
    if (!authUserId) return ok(res, { user: null });

    const account = await getAccountByUserId(authUserId);
    if (!account) return ok(res, { user: null });

    return ok(res, {
      user: {
        id: account.id,
        steamId: account.steam_id || null,
        steamId64: account.steam_id || null,
        nickname: account.persona_name || null,
        avatarUrl: account.avatar_full_url || account.avatar_medium_url || account.avatar_url || null,
        profileUrl: account.profile_url || null,
        elo2v2: Number(account.elo_2v2 || 100),
        wins2v2: Number(account.wins_2v2 || 0),
        losses2v2: Number(account.losses_2v2 || 0),
        matchesPlayed2v2: Number(account.matches_played_2v2 || 0),
        presence: account.presence || 'online'
      }
    });
  } catch (err) {
    console.error('auth /me error:', err);
    return fail(res, 500, 'auth_me_failed');
  }
});

router.post('/exchange', async (req, res) => {
  try {
    cleanupLoginExchanges();
    const exchange = String(req.body?.exchange || '').trim();
    const item = consumeLoginExchange(exchange);
    if (!item?.userId) return fail(res, 401, 'invalid_exchange');

    req.session.userId = item.userId;
    const account = await getAccountByUserId(item.userId);
    const authToken = createAuthToken(item.userId);

    req.session.save((err) => {
      if (err) {
        console.error('session save after exchange failed:', err);
        return fail(res, 500, 'session_save_failed');
      }

      return ok(res, {
        exchanged: true,
        token: authToken,
        user: account ? {
          id: account.id,
          steamId: account.steam_id || null,
          steamId64: account.steam_id || null,
          nickname: account.persona_name || null,
          avatarUrl: account.avatar_full_url || account.avatar_medium_url || account.avatar_url || null,
          profileUrl: account.profile_url || null,
          elo2v2: Number(account.elo_2v2 || 100),
          wins2v2: Number(account.wins_2v2 || 0),
          losses2v2: Number(account.losses_2v2 || 0),
          matchesPlayed2v2: Number(account.matches_played_2v2 || 0),
          presence: account.presence || 'online'
        } : null
      });
    });
  } catch (err) {
    console.error('auth /exchange error:', err);
    return fail(res, 500, 'auth_exchange_failed');
  }
});

router.get('/steam', (req, res) => {
  if (!config.backendBaseUrl) return fail(res, 500, 'backend_base_url_missing');
  if (!config.publicSiteUrl) return fail(res, 500, 'public_site_url_missing');

  req.session.postAuthReturnTo = sanitizeReturnTo(req.query.returnTo);

  const state = createSteamLoginState(req);
  const returnTo = `${normalizeBase(config.backendBaseUrl)}/auth/steam/callback?state=${encodeURIComponent(state)}`;
  const loginUrl = buildSteamLoginUrl(returnTo);

  req.session.save((err) => {
    if (err) {
      console.error('session save before steam redirect failed:', err);
      return fail(res, 500, 'session_save_failed');
    }
    return res.redirect(loginUrl);
  });
});

router.get('/steam/callback', async (req, res) => {
  try {
    cleanupLoginExchanges();

    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!validateSteamLoginState(req, state)) {
      return res.redirect(`${normalizeBase(config.publicSiteUrl)}/?auth_error=invalid_state`);
    }

    const steamId = await verifySteamOpenId(req.query);
    const profile = await fetchSteamProfile(steamId);
    const user = await upsertUserFromSteam(profile);

    req.session.userId = user.id;
    delete req.session.steamLoginState;

    await ensurePlayerProfile(user.id);
    await setPresence(user.id, 'online', null, null);

    const postAuthReturnTo = sanitizeReturnTo(req.session.postAuthReturnTo);
    delete req.session.postAuthReturnTo;
    const exchange = createLoginExchange(user.id);

    req.session.save((err) => {
      if (err) {
        console.error('session save after steam callback failed:', err);
      }
      return res.redirect(appendExchangeToReturnUrl(postAuthReturnTo, exchange));
    });
  } catch (err) {
    console.error('steam callback error:', err);
    return res.redirect(`${normalizeBase(config.publicSiteUrl)}/?auth_error=1`);
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('trust.sid', {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: config.cookieSecure ? 'none' : 'lax'
    });
    return ok(res, { loggedOut: true });
  });
});

module.exports = router;
