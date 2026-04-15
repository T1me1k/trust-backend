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

const router = express.Router();

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

    if (requested.origin !== publicSiteOrigin) {
      return fallback;
    }

    return requested.toString();
  } catch (_) {
    return fallback;
  }
}

router.get('/me', async (req, res) => {
  try {
    if (!req.session?.userId) return ok(res, { user: null });

    const account = await getAccountByUserId(req.session.userId);
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

router.get('/steam', (req, res) => {
  if (!config.backendBaseUrl) return fail(res, 500, 'backend_base_url_missing');
  if (!config.publicSiteUrl) return fail(res, 500, 'public_site_url_missing');

  const requestedReturnTo = sanitizeReturnTo(req.query.returnTo);
  req.session.postAuthReturnTo = requestedReturnTo;

  const state = createSteamLoginState(req);
  const callbackUrl = `${normalizeBase(config.backendBaseUrl)}/auth/steam/callback?state=${encodeURIComponent(state)}`;
  const loginUrl = buildSteamLoginUrl(callbackUrl);

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
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!validateSteamLoginState(req, state)) {
      return res.redirect(`${normalizeBase(config.publicSiteUrl)}/?auth_error=invalid_state`);
    }

    const steamId = await verifySteamOpenId(req.query);
    const profile = await fetchSteamProfile(steamId);
    const user = await upsertUserFromSteam(profile);

    req.session.userId = user.id;
    delete req.session.steamLoginState;

    const postAuthReturnTo = sanitizeReturnTo(req.session.postAuthReturnTo);
    delete req.session.postAuthReturnTo;

    await ensurePlayerProfile(user.id);
    await setPresence(user.id, 'online', null, null);

    req.session.save((err) => {
      if (err) {
        console.error('session save after steam callback failed:', err);
        return res.redirect(`${normalizeBase(config.publicSiteUrl)}/?auth_error=session_save_failed`);
      }
      return res.redirect(postAuthReturnTo);
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
