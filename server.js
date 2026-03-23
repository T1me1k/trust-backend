const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const crypto = require("crypto");
const session = require("express-session");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const SITE_ORIGIN = process.env.SITE_ORIGIN || process.env.PUBLIC_SITE_URL || "";
const PUBLIC_SITE_URL = process.env.PUBLIC_SITE_URL || SITE_ORIGIN || "";
const BACKEND_BASE_URL = process.env.BACKEND_BASE_URL || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "change_me_session_secret";
const STEAM_API_KEY = process.env.STEAM_API_KEY || "";
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || "true").toLowerCase() === "true";

function toOrigin(value) {
  if (!value) return "";
  try {
    return new URL(value).origin;
  } catch (_) {
    return value.replace(/\/+$/, "");
  }
}

const ALLOWED_ORIGINS = Array.from(
  new Set(
    [SITE_ORIGIN, PUBLIC_SITE_URL]
      .filter(Boolean)
      .map(toOrigin)
      .filter(Boolean)
  )
);

app.set("trust proxy", 1);

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || origin === "null") {
        return callback(null, true);
      }

      const normalizedOrigin = toOrigin(origin);

      if (ALLOWED_ORIGINS.includes(normalizedOrigin)) {
        return callback(null, true);
      }

      console.log("CORS blocked origin:", origin, "allowed:", ALLOWED_ORIGINS);
      return callback(null, false);
    },
    credentials: true
  })
);

app.use(
  session({
    name: "trust.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: COOKIE_SECURE,
      sameSite: COOKIE_SECURE ? "none" : "lax",
      maxAge: 1000 * 60 * 60 * 24 * 30
    }
  })
);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

const launcherConfig = {
  appName: "TRUST",
  minSupportedVersion: "0.1.0",
  latestVersion: "0.1.0",
  matchmakingEnabled: true,
  maintenance: false,
  motd: "Welcome to TRUST alpha matchmaking"
};

function requiredPlayers(mode) {
  if (mode === "2x2") return 4;
  if (mode === "5x5") return 10;
  return 0;
}

function newMatchId() {
  return "match_" + crypto.randomBytes(8).toString("hex");
}

function nowMs() {
  return Date.now();
}

function newLinkCode(length = 8) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(length);
  let out = "";

  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }

  return out;
}

function newLauncherLinkToken() {
  return crypto.randomBytes(24).toString("hex");
}

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function createSteamLoginState(req) {
  const raw = crypto.randomBytes(24).toString("hex");
  req.session.steamLoginState = sha256(raw);
  return raw;
}

function validateSteamLoginState(req, raw) {
  if (!raw || !req.session.steamLoginState) return false;
  return sha256(raw) === req.session.steamLoginState;
}

function buildSteamLoginUrl(returnTo) {
  const steamOpenIdEndpoint = "https://steamcommunity.com/openid/login";
  const steamOpenIdNs = "http://specs.openid.net/auth/2.0";

  const backendRealm = toOrigin(BACKEND_BASE_URL);

  const params = new URLSearchParams({
    "openid.ns": steamOpenIdNs,
    "openid.mode": "checkid_setup",
    "openid.return_to": returnTo,
    "openid.realm": backendRealm,
    "openid.identity": `${steamOpenIdNs}/identifier_select`,
    "openid.claimed_id": `${steamOpenIdNs}/identifier_select`
  });

  return `${steamOpenIdEndpoint}?${params.toString()}`;
}

async function verifySteamOpenId(queryParams) {
  const steamOpenIdEndpoint = "https://steamcommunity.com/openid/login";
  const claimedIdRegex = /^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17,25})$/i;

  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(queryParams)) {
    if (typeof value === "string") {
      params.set(key, value);
    }
  }

  params.set("openid.mode", "check_authentication");

  const response = await fetch(steamOpenIdEndpoint, {
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

  const match = claimedId && claimedId.match(claimedIdRegex);
  if (!match) {
    throw new Error("Invalid Steam claimed_id");
  }

  return match[1];
}

async function fetchSteamProfile(steamId) {
  if (!STEAM_API_KEY) {
    return {
      steamid: steamId,
      personaname: null,
      profileurl: `https://steamcommunity.com/profiles/${steamId}`,
      avatar: null,
      avatarmedium: null,
      avatarfull: null
    };
  }

  const url = new URL("https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/");
  url.searchParams.set("key", STEAM_API_KEY);
  url.searchParams.set("steamids", steamId);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Steam profile fetch failed: ${response.status}`);
  }

  const data = await response.json();
  const player = data?.response?.players?.[0];

  return {
    steamid: steamId,
    personaname: player?.personaname || null,
    profileurl: player?.profileurl || `https://steamcommunity.com/profiles/${steamId}`,
    avatar: player?.avatar || null,
    avatarmedium: player?.avatarmedium || null,
    avatarfull: player?.avatarfull || null
  };
}

async function upsertUserFromSteam(profile) {
  const result = await pool.query(
    `
    INSERT INTO users (
      steam_id,
      persona_name,
      profile_url,
      avatar_url,
      avatar_medium_url,
      avatar_full_url,
      created_at,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
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

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

async function ensureSchema() {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS presence (
      client_id TEXT PRIMARY KEY,
      nickname TEXT NOT NULL,
      last_seen_ms BIGINT NOT NULL DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS queue_entries (
      client_id TEXT PRIMARY KEY,
      nickname TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      match_id TEXT,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_ms BIGINT NOT NULL DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS matches (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS match_players (
      id SERIAL PRIMARY KEY,
      match_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      nickname TEXT NOT NULL,
      accepted BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_queue_mode_status
    ON queue_entries(mode, status)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_queue_last_seen
    ON queue_entries(last_seen_ms)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_presence_last_seen
    ON presence(last_seen_ms)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_match_players_match_id
    ON match_players(match_id)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      steam_id VARCHAR(32) NOT NULL UNIQUE,
      persona_name TEXT,
      profile_url TEXT,
      avatar_url TEXT,
      avatar_medium_url TEXT,
      avatar_full_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS launcher_links (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL UNIQUE,
      nickname TEXT,
      linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_launcher_links_user_id
    ON launcher_links(user_id)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS launcher_link_codes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code VARCHAR(16) NOT NULL UNIQUE,
      client_id TEXT NOT NULL,
      nickname TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      consumed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_launcher_link_codes_code
    ON launcher_link_codes(code)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_launcher_link_codes_client_id
    ON launcher_link_codes(client_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_launcher_link_codes_expires_at
    ON launcher_link_codes(expires_at)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS launcher_link_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      token TEXT NOT NULL UNIQUE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_launcher_link_tokens_token
    ON launcher_link_tokens(token)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_launcher_link_tokens_user_id
    ON launcher_link_tokens(user_id)
  `);

  // NEW: player profile / rank / season
  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_profiles (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      mmr INTEGER NOT NULL DEFAULT 1000,
      rank_name TEXT NOT NULL DEFAULT 'UNRANKED',
      season_name TEXT NOT NULL DEFAULT 'TRUST Alpha Season',
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      matches_played INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function ensurePlayerProfileByUserId(userId) {
  await pool.query(
    `
    INSERT INTO player_profiles (
      user_id,
      mmr,
      rank_name,
      season_name,
      wins,
      losses,
      matches_played,
      updated_at
    )
    VALUES ($1, 1000, 'UNRANKED', 'TRUST Alpha Season', 0, 0, 0, NOW())
    ON CONFLICT (user_id)
    DO NOTHING
    `,
    [userId]
  );
}

async function pingPresence(clientId, nickname) {
  const existing = await pool.query(
    `
    SELECT client_id
    FROM presence
    WHERE client_id = $1
    LIMIT 1
    `,
    [clientId]
  );

  if (existing.rows.length > 0) {
    await pool.query(
      `
      UPDATE presence
      SET nickname = $2,
          last_seen_ms = $3
      WHERE client_id = $1
      `,
      [clientId, nickname, nowMs()]
    );
  } else {
    await pool.query(
      `
      INSERT INTO presence (client_id, nickname, last_seen_ms)
      VALUES ($1, $2, $3)
      `,
      [clientId, nickname, nowMs()]
    );
  }
}

async function getOnlineCount() {
  const cutoff = nowMs() - 30000;

  const q = await pool.query(
    `
    SELECT COUNT(*)::int AS online_count
    FROM presence
    WHERE last_seen_ms >= $1
    `,
    [cutoff]
  );

  return q.rows[0]?.online_count || 0;
}

async function cleanupStaleQueueEntries() {
  const cutoff = nowMs() - 45000;

  await pool.query(
    `
    DELETE FROM queue_entries
    WHERE last_seen_ms < $1
      AND status = 'searching'
    `,
    [cutoff]
  );
}

async function cleanupStalePresence() {
  const cutoff = nowMs() - 60000;

  await pool.query(
    `
    DELETE FROM presence
    WHERE last_seen_ms < $1
    `,
    [cutoff]
  );
}

async function cleanupExpiredLinkCodes() {
  await pool.query(`
    DELETE FROM launcher_link_codes
    WHERE expires_at < NOW() - INTERVAL '1 day'
  `);
}

async function cleanupExpiredLauncherLinkTokens() {
  await pool.query(`
    DELETE FROM launcher_link_tokens
    WHERE expires_at < NOW() - INTERVAL '1 day'
  `);
}

async function tryCreateMatch(mode) {
  const need = requiredPlayers(mode);
  if (!need) return null;

  await cleanupStaleQueueEntries();

  const cutoff = nowMs() - 45000;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const q = await client.query(
      `
      SELECT client_id, nickname
      FROM queue_entries
      WHERE mode = $1
        AND status = 'searching'
        AND last_seen_ms >= $2
      ORDER BY joined_at ASC
      LIMIT $3
      FOR UPDATE
      `,
      [mode, cutoff, need]
    );

    if (q.rows.length < need) {
      await client.query("ROLLBACK");
      return null;
    }

    const matchId = newMatchId();

    await client.query(
      `
      INSERT INTO matches (id, mode, status, created_at)
      VALUES ($1, $2, 'found', NOW())
      `,
      [matchId, mode]
    );

    for (const row of q.rows) {
      await client.query(
        `
        INSERT INTO match_players (match_id, client_id, nickname, accepted, created_at)
        VALUES ($1, $2, $3, FALSE, NOW())
        `,
        [matchId, row.client_id, row.nickname]
      );

      await client.query(
        `
        UPDATE queue_entries
        SET status = 'match_found',
            match_id = $1,
            updated_at = NOW()
        WHERE client_id = $2
        `,
        [matchId, row.client_id]
      );
    }

    await client.query("COMMIT");
    return matchId;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function recomputeMatchStatus(matchId) {
  const players = await pool.query(
    `
    SELECT accepted
    FROM match_players
    WHERE match_id = $1
    `,
    [matchId]
  );

  if (players.rows.length === 0) return;

  const allAccepted = players.rows.every((p) => p.accepted === true);

  if (allAccepted) {
    await pool.query(
      `
      UPDATE matches
      SET status = 'ready'
      WHERE id = $1
      `,
      [matchId]
    );

    await pool.query(
      `
      UPDATE queue_entries
      SET status = 'accepted',
          updated_at = NOW()
      WHERE match_id = $1
      `,
      [matchId]
    );
  }
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "trust-backend",
    message: "TRUST backend is running"
  });
});

app.get("/health", async (req, res) => {
  const onlineCount = await getOnlineCount();

  res.json({
    ok: true,
    status: "online",
    onlineCount,
    timestamp: Date.now()
  });
});

app.get("/config", (req, res) => {
  res.json({
    ok: true,
    config: launcherConfig
  });
});

app.post("/presence/ping", async (req, res) => {
  try {
    const { clientId, nickname } = req.body || {};

    if (!clientId || !nickname) {
      return res.status(400).json({
        ok: false,
        error: "missing_fields"
      });
    }

    await pingPresence(clientId, nickname);

    res.json({ ok: true });
  } catch (err) {
    console.error("presence ping error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

app.post("/queue/join", async (req, res) => {
  try {
    if (launcherConfig.maintenance) {
      return res.status(503).json({
        ok: false,
        error: "maintenance"
      });
    }

    if (!launcherConfig.matchmakingEnabled) {
      return res.status(503).json({
        ok: false,
        error: "matchmaking_disabled"
      });
    }

    const { clientId, nickname, mode } = req.body || {};

    if (!clientId || !nickname || !mode) {
      return res.status(400).json({
        ok: false,
        error: "missing_fields"
      });
    }

    if (mode !== "2x2" && mode !== "5x5") {
      return res.status(400).json({
        ok: false,
        error: "invalid_mode"
      });
    }

    await pool.query(
      `
      INSERT INTO queue_entries (client_id, nickname, mode, status, match_id, joined_at, updated_at, last_seen_ms)
      VALUES ($1, $2, $3, 'searching', NULL, NOW(), NOW(), $4)
      ON CONFLICT (client_id)
      DO UPDATE SET
        nickname = EXCLUDED.nickname,
        mode = EXCLUDED.mode,
        status = 'searching',
        match_id = NULL,
        updated_at = NOW(),
        last_seen_ms = EXCLUDED.last_seen_ms
      `,
      [clientId, nickname, mode, nowMs()]
    );

    const matchId = await tryCreateMatch(mode);

    res.json({
      ok: true,
      state: matchId ? "match_found" : "searching",
      matchId: matchId || null
    });
  } catch (err) {
    console.error("join error:", err);
    res.status(500).json({
      ok: false,
      error: "internal_error"
    });
  }
});

app.post("/queue/leave", async (req, res) => {
  try {
    const { clientId } = req.body || {};

    if (!clientId) {
      return res.status(400).json({
        ok: false,
        error: "missing_client_id"
      });
    }

    await pool.query(
      `
      DELETE FROM queue_entries
      WHERE client_id = $1
      `,
      [clientId]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("leave error:", err);
    res.status(500).json({
      ok: false,
      error: "internal_error"
    });
  }
});

app.get("/queue/status", async (req, res) => {
  try {
    const clientId = req.query.clientId;
    if (!clientId) {
      return res.status(400).json({
        ok: false,
        error: "missing_client_id"
      });
    }

    const q = await pool.query(
      `
      SELECT client_id, nickname, mode, status, match_id
      FROM queue_entries
      WHERE client_id = $1
      LIMIT 1
      `,
      [clientId]
    );

    if (q.rows.length === 0) {
      return res.json({
        ok: true,
        state: "idle"
      });
    }

    const row = q.rows[0];

    if (!row.match_id) {
      return res.json({
        ok: true,
        state: row.status
      });
    }

    const mp = await pool.query(
      `
      SELECT COUNT(*)::int AS total_players,
             COUNT(*) FILTER (WHERE accepted = TRUE)::int AS accepted_players
      FROM match_players
      WHERE match_id = $1
      `,
      [row.match_id]
    );

    const matchInfo = await pool.query(
      `
      SELECT status, mode
      FROM matches
      WHERE id = $1
      LIMIT 1
      `,
      [row.match_id]
    );

    const totalPlayers = mp.rows[0]?.total_players || 0;
    const acceptedPlayers = mp.rows[0]?.accepted_players || 0;
    const matchStatus = matchInfo.rows[0]?.status || row.status;

    let state = row.status;
    if (matchStatus === "ready") {
      state = "accepted";
    } else if (row.status === "accepted") {
      state = acceptedPlayers < totalPlayers ? "accepted_waiting_others" : "accepted";
    }

    return res.json({
      ok: true,
      state,
      matchId: row.match_id,
      totalPlayers,
      acceptedPlayers,
      mode: matchInfo.rows[0]?.mode || row.mode
    });
  } catch (err) {
    console.error("queue status error:", err);
    return res.status(500).json({
      ok: false,
      error: "internal_error"
    });
  }
});

app.post("/match/accept", async (req, res) => {
  try {
    const { clientId, matchId } = req.body || {};

    if (!clientId || !matchId) {
      return res.status(400).json({
        ok: false,
        error: "missing_fields"
      });
    }

    await pool.query(
      `
      UPDATE match_players
      SET accepted = TRUE
      WHERE match_id = $1 AND client_id = $2
      `,
      [matchId, clientId]
    );

    await pool.query(
      `
      UPDATE queue_entries
      SET status = 'accepted',
          updated_at = NOW()
      WHERE client_id = $1
      `,
      [clientId]
    );

    await recomputeMatchStatus(matchId);

    return res.json({ ok: true });
  } catch (err) {
    console.error("match accept error:", err);
    return res.status(500).json({
      ok: false,
      error: "internal_error"
    });
  }
});

app.post("/match/decline", async (req, res) => {
  try {
    const { clientId, matchId } = req.body || {};

    if (!clientId || !matchId) {
      return res.status(400).json({
        ok: false,
        error: "missing_fields"
      });
    }

    await pool.query(
      `
      DELETE FROM queue_entries
      WHERE client_id = $1
      `,
      [clientId]
    );

    await pool.query(
      `
      UPDATE matches
      SET status = 'cancelled'
      WHERE id = $1
      `,
      [matchId]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("match decline error:", err);
    return res.status(500).json({
      ok: false,
      error: "internal_error"
    });
  }
});

app.get("/match/:matchId", async (req, res) => {
  try {
    const matchId = req.params.matchId;

    const matchQ = await pool.query(
      `
      SELECT id, mode, status
      FROM matches
      WHERE id = $1
      LIMIT 1
      `,
      [matchId]
    );

    if (matchQ.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "match_not_found"
      });
    }

    const playersQ = await pool.query(
      `
      SELECT client_id, nickname, accepted
      FROM match_players
      WHERE match_id = $1
      ORDER BY id ASC
      `,
      [matchId]
    );

    return res.json({
      ok: true,
      matchId,
      mode: matchQ.rows[0].mode,
      status: matchQ.rows[0].status,
      players: playersQ.rows.map((p) => ({
        clientId: p.client_id,
        nickname: p.nickname,
        accepted: !!p.accepted
      }))
    });
  } catch (err) {
    console.error("match details error:", err);
    return res.status(500).json({
      ok: false,
      error: "internal_error"
    });
  }
});

app.get("/auth/me", requireAuth, async (req, res) => {
  try {
    const q = await pool.query(
      `
      SELECT id, steam_id, persona_name, profile_url, avatar_full_url
      FROM users
      WHERE id = $1
      LIMIT 1
      `,
      [req.session.userId]
    );

    const row = q.rows[0];
    if (!row) {
      return res.status(404).json({
        ok: false,
        error: "user_not_found"
      });
    }

    res.json({
      ok: true,
      user: row
    });
  } catch (err) {
    console.error("auth/me error:", err);
    res.status(500).json({
      ok: false,
      error: "internal_error"
    });
  }
});

app.get("/auth/steam", (req, res) => {
  try {
    const state = createSteamLoginState(req);
    const returnTo = `${BACKEND_BASE_URL}/auth/steam/callback?state=${encodeURIComponent(state)}`;
    const url = buildSteamLoginUrl(returnTo);
    res.redirect(url);
  } catch (err) {
    console.error("auth/steam error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

app.get("/auth/steam/callback", async (req, res) => {
  try {
    const state = String(req.query.state || "");
    if (!validateSteamLoginState(req, state)) {
      return res.status(400).send("Invalid Steam login state");
    }

    const steamId = await verifySteamOpenId(req.query);
    const profile = await fetchSteamProfile(steamId);
    const user = await upsertUserFromSteam(profile);

    req.session.userId = user.id;
    delete req.session.steamLoginState;

    await ensurePlayerProfileByUserId(user.id);

    return res.redirect(`${PUBLIC_SITE_URL}`);
  } catch (err) {
    console.error("auth/steam/callback error:", err);
    return res.status(500).send("Steam login failed");
  }
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.post("/launcher/link/start", requireAuth, async (req, res) => {
  try {
    const token = newLauncherLinkToken();

    await pool.query(
      `
      INSERT INTO launcher_link_tokens (
        token,
        user_id,
        expires_at
      )
      VALUES ($1, $2, NOW() + INTERVAL '5 minutes')
      `,
      [token, req.session.userId]
    );

    return res.json({
      ok: true,
      token,
      launchUrl: `trust://link?token=${encodeURIComponent(token)}`
    });
  } catch (err) {
    console.error("launcher link start error:", err);
    return res.status(500).json({
      ok: false,
      error: "internal_error",
      details: err.message
    });
  }
});

app.post("/launcher/link/complete", async (req, res) => {
  try {
    const { clientId, nickname, token } = req.body || {};

    if (!clientId || !token) {
      return res.status(400).json({
        ok: false,
        error: "missing_fields"
      });
    }

    const tokenResult = await pool.query(
      `
      SELECT *
      FROM launcher_link_tokens
      WHERE token = $1
      LIMIT 1
      `,
      [token]
    );

    const row = tokenResult.rows[0];

    if (!row) {
      return res.status(400).json({
        ok: false,
        error: "invalid_token"
      });
    }

    if (row.consumed_at) {
      return res.status(400).json({
        ok: false,
        error: "token_already_used"
      });
    }

    if (new Date(row.expires_at).getTime() < Date.now()) {
      return res.status(400).json({
        ok: false,
        error: "token_expired"
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `
        INSERT INTO launcher_links (
          user_id,
          client_id,
          nickname
        )
        VALUES ($1, $2, $3)
        ON CONFLICT (client_id)
        DO UPDATE SET
          user_id = EXCLUDED.user_id,
          nickname = EXCLUDED.nickname,
          linked_at = NOW()
        `,
        [row.user_id, clientId, typeof nickname === "string" ? nickname.trim() : null]
      );

      await ensurePlayerProfileByUserId(row.user_id);

      await client.query(
        `
        UPDATE launcher_link_tokens
        SET consumed_at = NOW()
        WHERE id = $1
        `,
        [row.id]
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return res.json({
      ok: true,
      linked: true
    });
  } catch (err) {
    console.error("launcher link complete error:", err);
    return res.status(500).json({
      ok: false,
      error: "internal_error",
      details: err.message
    });
  }
});

app.post("/launcher/link/code/create", async (req, res) => {
  try {
    const { clientId, nickname } = req.body || {};

    if (!clientId) {
      return res.status(400).json({
        ok: false,
        error: "missing_client_id"
      });
    }

    const code = newLinkCode(8);

    const result = await pool.query(
      `
      INSERT INTO launcher_link_codes (
        code,
        client_id,
        nickname,
        expires_at
      )
      VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes')
      RETURNING code, client_id, nickname, expires_at
      `,
      [code, clientId, typeof nickname === "string" ? nickname.trim() : null]
    );

    return res.json({
      ok: true,
      code: result.rows[0].code,
      expiresAt: result.rows[0].expires_at
    });
  } catch (err) {
    console.error("create link code error:", err);
    res.status(500).json({
      ok: false,
      error: "internal_error",
      details: err.message
    });
  }
});

app.post("/launcher/link/confirm", requireAuth, async (req, res) => {
  try {
    const code = String(req.body?.code || "").trim().toUpperCase();

    if (!code) {
      return res.status(400).json({ ok: false, error: "code is required" });
    }

    const codeResult = await pool.query(
      `
      SELECT *
      FROM launcher_link_codes
      WHERE code = $1
      LIMIT 1
      `,
      [code]
    );

    const row = codeResult.rows[0];

    if (!row) {
      return res.status(400).json({ ok: false, error: "invalid_link_code" });
    }

    if (row.consumed_at) {
      return res.status(400).json({ ok: false, error: "link_code_already_used" });
    }

    if (new Date(row.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ ok: false, error: "link_code_expired" });
    }

    const existingClientLink = await pool.query(
      `
      SELECT *
      FROM launcher_links
      WHERE client_id = $1
      LIMIT 1
      `,
      [row.client_id]
    );

    if (existingClientLink.rows.length > 0) {
      await pool.query(
        `
        UPDATE launcher_link_codes
        SET consumed_at = NOW(),
            consumed_by_user_id = $2
        WHERE id = $1
        `,
        [row.id, req.session.userId]
      );

      await ensurePlayerProfileByUserId(req.session.userId);

      return res.json({
        ok: true,
        linked: true,
        alreadyLinked: true,
        clientId: row.client_id,
        nickname: row.nickname
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `
        INSERT INTO launcher_links (
          user_id,
          client_id,
          nickname
        )
        VALUES ($1, $2, $3)
        ON CONFLICT (client_id)
        DO NOTHING
        `,
        [req.session.userId, row.client_id, row.nickname]
      );

      await ensurePlayerProfileByUserId(req.session.userId);

      await client.query(
        `
        UPDATE launcher_link_codes
        SET consumed_at = NOW(),
            consumed_by_user_id = $2
        WHERE id = $1
        `,
        [row.id, req.session.userId]
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return res.json({
      ok: true,
      linked: true,
      alreadyLinked: false,
      clientId: row.client_id,
      nickname: row.nickname
    });
  } catch (err) {
    console.error("confirm link code error:", err);
    return res.status(500).json({
      ok: false,
      error: "internal_error",
      details: err.message
    });
  }
});

app.get("/launcher/account/by-client/:clientId", async (req, res) => {
  try {
    const clientId = String(req.params.clientId || "").trim();

    if (!clientId) {
      return res.status(400).json({
        ok: false,
        error: "missing_client_id"
      });
    }

    const result = await pool.query(
      `
      SELECT
        ll.client_id,
        ll.nickname,
        ll.linked_at,
        u.id AS user_id,
        u.steam_id,
        u.persona_name,
        u.profile_url,
        u.avatar_full_url
      FROM launcher_links ll
      JOIN users u ON u.id = ll.user_id
      WHERE ll.client_id = $1
      LIMIT 1
      `,
      [clientId]
    );

    const row = result.rows[0];
    if (!row) {
      return res.json({
        ok: true,
        linked: false
      });
    }

    return res.json({
      ok: true,
      linked: true,
      client_id: row.client_id,
      steam_id: row.steam_id,
      persona_name: row.persona_name,
      profile_url: row.profile_url,
      avatar_full_url: row.avatar_full_url,
      linked_at: row.linked_at
    });
  } catch (err) {
    console.error("launcher account by client error:", err);
    return res.status(500).json({
      ok: false,
      error: "internal_error",
      details: err.message
    });
  }
});

// NEW: launcher profile
app.get("/launcher/profile/by-client/:clientId", async (req, res) => {
  try {
    const clientId = String(req.params.clientId || "").trim();

    if (!clientId) {
      return res.status(400).json({
        ok: false,
        error: "missing_client_id"
      });
    }

    const accountResult = await pool.query(
      `
      SELECT
        ll.client_id,
        ll.user_id,
        u.steam_id,
        u.persona_name,
        u.profile_url,
        u.avatar_full_url
      FROM launcher_links ll
      JOIN users u ON u.id = ll.user_id
      WHERE ll.client_id = $1
      LIMIT 1
      `,
      [clientId]
    );

    const row = accountResult.rows[0];
    if (!row) {
      return res.json({
        ok: true,
        linked: false
      });
    }

    await ensurePlayerProfileByUserId(row.user_id);

    const profileResult = await pool.query(
      `
      SELECT
        user_id,
        mmr,
        rank_name,
        season_name,
        wins,
        losses,
        matches_played,
        updated_at
      FROM player_profiles
      WHERE user_id = $1
      LIMIT 1
      `,
      [row.user_id]
    );

    const profile = profileResult.rows[0];

    return res.json({
      ok: true,
      linked: true,
      client_id: row.client_id,
      steam_id: row.steam_id,
      persona_name: row.persona_name,
      profile_url: row.profile_url,
      avatar_full_url: row.avatar_full_url,
      mmr: profile?.mmr ?? 1000,
      rank_name: profile?.rank_name ?? "UNRANKED",
      season_name: profile?.season_name ?? "TRUST Alpha Season",
      wins: profile?.wins ?? 0,
      losses: profile?.losses ?? 0,
      matches_played: profile?.matches_played ?? 0,
      updated_at: profile?.updated_at ?? null
    });
  } catch (err) {
    console.error("launcher profile by client error:", err);
    return res.status(500).json({
      ok: false,
      error: "internal_error",
      details: err.message
    });
  }
});

async function boot() {
  try {
    await ensureSchema();

    setInterval(() => {
      cleanupStalePresence().catch((err) => console.error("cleanupStalePresence:", err));
      cleanupStaleQueueEntries().catch((err) => console.error("cleanupStaleQueueEntries:", err));
      cleanupExpiredLinkCodes().catch((err) => console.error("cleanupExpiredLinkCodes:", err));
      cleanupExpiredLauncherLinkTokens().catch((err) => console.error("cleanupExpiredLauncherLinkTokens:", err));
    }, 30000);

    app.listen(PORT, () => {
      console.log(`TRUST backend listening on port ${PORT}`);
    });
  } catch (err) {
    console.error("boot error:", err);
    process.exit(1);
  }
}

boot();
