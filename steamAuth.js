import crypto from "crypto";
import fetch from "node-fetch";
import { query } from "./db.js";

const STEAM_OPENID_ENDPOINT = "https://steamcommunity.com/openid/login";
const STEAM_OPENID_NS = "http://specs.openid.net/auth/2.0";
const CLAIMED_ID_REGEX = /^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17,25})$/i;

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function buildSteamLoginUrl(returnTo) {
  const params = new URLSearchParams({
    "openid.ns": STEAM_OPENID_NS,
    "openid.mode": "checkid_setup",
    "openid.return_to": returnTo,
    "openid.realm": process.env.PUBLIC_BASE_URL,
    "openid.identity": `${STEAM_OPENID_NS}/identifier_select`,
    "openid.claimed_id": `${STEAM_OPENID_NS}/identifier_select`
  });

  return `${STEAM_OPENID_ENDPOINT}?${params.toString()}`;
}

export async function verifySteamOpenId(queryParams) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(queryParams)) {
    params.set(key, value);
  }

  params.set("openid.mode", "check_authentication");

  const response = await fetch(STEAM_OPENID_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });

  const text = await response.text();

  if (!text.includes("is_valid:true")) {
    throw new Error("Steam OpenID verification failed");
  }

  const claimedId =
    queryParams["openid.claimed_id"] || queryParams["openid.identity"];

  const match = claimedId?.match(CLAIMED_ID_REGEX);
  if (!match) {
    throw new Error("Invalid Steam claimed_id");
  }

  return match[1];
}

export async function fetchSteamProfile(steamId) {
  const apiKey = process.env.STEAM_API_KEY;
  if (!apiKey) {
    return {
      steamid: steamId,
      personaname: null,
      profileurl: null,
      avatar: null,
      avatarmedium: null,
      avatarfull: null
    };
  }

  const url = new URL("https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("steamids", steamId);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Steam profile fetch failed: ${response.status}`);
  }

  const data = await response.json();
  const player = data?.response?.players?.[0];

  return {
    steamid: steamId,
    personaname: player?.personaname ?? null,
    profileurl: player?.profileurl ?? null,
    avatar: player?.avatar ?? null,
    avatarmedium: player?.avatarmedium ?? null,
    avatarfull: player?.avatarfull ?? null
  };
}

export async function upsertUserFromSteam(profile) {
  const result = await query(
    `
    INSERT INTO users (
      steam_id,
      persona_name,
      profile_url,
      avatar_url,
      avatar_medium_url,
      avatar_full_url,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (steam_id)
    DO UPDATE SET
      persona_name = EXCLUDED.persona_name,
      profile_url = EXCLUDED.profile_url,
      avatar_url = EXCLUDED.avatar_url,
      avatar_medium_url = EXCLUDED.avatar_medium_url,
      avatar_full_url = EXCLUDED.avatar_full_url,
      updated_at = NOW()
    RETURNING *
    `,
    [
      profile.steamid,
      profile.personaname,
      profile.profileurl,
      profile.avatar,
      profile.avatarmedium,
      profile.avatarfull
    ]
  );

  return result.rows[0];
}

export function createLoginState(req) {
  const nonce = crypto.randomBytes(24).toString("hex");
  req.session.steamLoginState = sha256(nonce);
  return nonce;
}

export function validateLoginState(req, rawState) {
  if (!rawState || !req.session.steamLoginState) return false;
  const actual = sha256(rawState);
  return actual === req.session.steamLoginState;
}