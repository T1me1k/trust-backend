const express = require('express');
const { ok, fail } = require('../utils/http');
const { createAuthToken } = require('../utils/authToken');
const { getAuthenticatedUserId } = require('../middleware/auth');
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

router.get('/me', async (req, res) => {
  try {
    const userId = getAuthenticatedUserId(req);
    if (!userId) return ok(res, { user: null });

    const account = await getAccountByUserId(userId);
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

  const state = createSteamLoginState();
  const returnTo = `${config.backendBaseUrl.replace(/\/+$/, '')}/auth/steam/callback?state=${encodeURIComponent(state)}`;
  const loginUrl = buildSteamLoginUrl(returnTo);

  return res.redirect(loginUrl);
});

router.get('/steam/callback', async (req, res) => {
  try {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!validateSteamLoginState(req, state)) {
      return res.redirect(`${config.publicSiteUrl.replace(/\/+$/, '')}/?auth_error=invalid_state`);
    }

    const steamId = await verifySteamOpenId(req.query);
    const profile = await fetchSteamProfile(steamId);
    const user = await upsertUserFromSteam(profile);

    req.session.userId = user.id;
    await ensurePlayerProfile(user.id);
    await setPresence(user.id, 'online', null, null);

    const authToken = createAuthToken(user.id);

    req.session.save((err) => {
      if (err) {
        console.error('session save after steam callback failed:', err);
      }
      return res.redirect(`${config.publicSiteUrl.replace(/\/+$/, '')}/app.html#auth_token=${encodeURIComponent(authToken)}`);
    });
  } catch (err) {
    console.error('steam callback error:', err);
    return res.redirect(`${config.publicSiteUrl.replace(/\/+$/, '')}/?auth_error=1`);
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
