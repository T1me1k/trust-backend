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

router.get('/me', async (req, res) => {
  if (!req.session.userId) return ok(res, { user: null });
  const account = await getAccountByUserId(req.session.userId);
  return ok(res, {
    user: account ? {
      id: account.id,
      steamId: account.steam_id,
      nickname: account.persona_name,
      avatarUrl: account.avatar_full_url,
      profileUrl: account.profile_url,
      elo2v2: account.elo_2v2,
      wins2v2: account.wins_2v2,
      losses2v2: account.losses_2v2,
      matchesPlayed2v2: account.matches_played_2v2,
      presence: account.presence
    } : null
  });
});

router.get('/steam', (req, res) => {
  if (!config.backendBaseUrl) return fail(res, 500, 'backend_base_url_missing');

  const state = createSteamLoginState(req);
  const returnTo = `${config.backendBaseUrl.replace(/\/+$/, '')}/auth/steam/callback?state=${encodeURIComponent(state)}`;
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
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!validateSteamLoginState(req, state)) {
      return res.redirect(`${config.publicSiteUrl.replace(/\/+$/, '')}/?auth_error=invalid_state`);
    }

    const steamId = await verifySteamOpenId(req.query);
    const profile = await fetchSteamProfile(steamId);
    const user = await upsertUserFromSteam(profile);

    req.session.userId = user.id;
    delete req.session.steamLoginState;

    await ensurePlayerProfile(user.id);
    await setPresence(user.id, 'online', null, null);

    req.session.save((err) => {
      if (err) {
        console.error('session save after steam callback failed:', err);
        return res.redirect(`${config.publicSiteUrl.replace(/\/+$/, '')}/?auth_error=session_save_failed`);
      }
      return res.redirect(`${config.publicSiteUrl.replace(/\/+$/, '')}/app.html`);
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
