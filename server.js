const crypto = require('crypto');
const fetch = require('node-fetch');
const config = require('../config');
const { query } = require('../db');

const STEAM_OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';
const STEAM_OPENID_NS = 'http://specs.openid.net/auth/2.0';
const CLAIMED_ID_REGEX = /^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17,25})$/i;

function sha256(input) {
  return crypto.createHash('sha256').update(String(input || '')).digest('hex');
}

function buildSteamLoginUrl(returnTo) {
  const params = new URLSearchParams({
    'openid.ns': STEAM_OPENID_NS,
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.realm': new URL(config.backendBaseUrl).origin,
    'openid.identity': `${STEAM_OPENID_NS}/identifier_select`,
    'openid.claimed_id': `${STEAM_OPENID_NS}/identifier_select`
  });

  return `${STEAM_OPENID_ENDPOINT}?${params.toString()}`;
}

async function verifySteamOpenId(queryParams) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(queryParams || {})) {
    if (typeof value === 'string') {
      params.set(key, value);
    }
  }

  params.set('openid.mode', 'check_authentication');

  const response = await fetch(STEAM_OPENID_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  const text = await response.text();
  if (!text.includes('is_valid:true')) {
    throw new Error('Steam OpenID verification failed');
  }

  const claimedId = queryParams['openid.claimed_id'] || queryParams['openid.identity'];
  const match = claimedId && claimedId.match(CLAIMED_ID_REGEX);
  if (!match) {
    throw new Error('Invalid Steam claimed_id');
  }

  return match[1];
}

async function fetchSteamProfile(steamId) {
  if (!config.steamApiKey) {
    return {
      steamid: steamId,
      personaname: `Steam_${steamId}`,
      profileurl: `https://steamcommunity.com/profiles/${steamId}`,
      avatar: null,
      avatarmedium: null,
      avatarfull: null
    };
  }

  const url = new URL('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/');
  url.searchParams.set('key', config.steamApiKey);
  url.searchParams.set('steamids', steamId);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Steam profile fetch failed: ${response.status}`);
  }

  const data = await response.json();
  const player = data?.response?.players?.[0] || {};

  return {
    steamid: steamId,
    personaname: player.personaname || `Steam_${steamId}`,
    profileurl: player.profileurl || `https://steamcommunity.com/profiles/${steamId}`,
    avatar: player.avatar || null,
    avatarmedium: player.avatarmedium || null,
    avatarfull: player.avatarfull || null
  };
}

async function upsertUserFromSteam(profile) {
  const steamId = String(profile?.steamid || '').trim();
  if (!steamId) {
    throw new Error('Steam profile is missing steamid');
  }

  const personaName = String(profile?.personaname || `Steam_${steamId}`).trim();
  const profileUrl = profile?.profileurl || `https://steamcommunity.com/profiles/${steamId}`;
  const avatarUrl = profile?.avatar || null;
  const avatarMediumUrl = profile?.avatarmedium || null;
  const avatarFullUrl = profile?.avatarfull || profile?.avatarmedium || profile?.avatar || null;

  const result = await query(
    `
    INSERT INTO users (
      steam_id,
      persona_name,
      profile_url,
      avatar_url,
      avatar_medium_url,
      avatar_full_url,
      created_at,
      updated_at,
      last_login_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW(), NOW())
    ON CONFLICT (steam_id)
    DO UPDATE SET
      persona_name = EXCLUDED.persona_name,
      profile_url = EXCLUDED.profile_url,
      avatar_url = EXCLUDED.avatar_url,
      avatar_medium_url = EXCLUDED.avatar_medium_url,
      avatar_full_url = EXCLUDED.avatar_full_url,
      updated_at = NOW(),
      last_login_at = NOW()
    RETURNING *
    `,
    [steamId, personaName, profileUrl, avatarUrl, avatarMediumUrl, avatarFullUrl]
  );

  return result.rows[0];
}

function createSteamLoginState(req) {
  const raw = crypto.randomBytes(24).toString('hex');
  req.session.steamLoginState = sha256(raw);
  return raw;
}

function validateSteamLoginState(req, raw) {
  return !!(
    raw &&
    req.session?.steamLoginState &&
    sha256(raw) === req.session.steamLoginState
  );
}

module.exports = {
  buildSteamLoginUrl,
  verifySteamOpenId,
  fetchSteamProfile,
  upsertUserFromSteam,
  createSteamLoginState,
  validateSteamLoginState
};
