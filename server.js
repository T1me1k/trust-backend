const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

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

async function tryCreateMatch(mode) {
  const need = requiredPlayers(mode);
  if (!need) return null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const q = await client.query(
      `
      SELECT client_id, nickname
      FROM queue_entries
      WHERE mode = $1 AND status = 'searching'
      ORDER BY joined_at ASC
      LIMIT $2
      FOR UPDATE
      `,
      [mode, need]
    );

    if (q.rows.length < need) {
      await client.query("ROLLBACK");
      return null;
    }

    const matchId = newMatchId();

    await client.query(
      `
      INSERT INTO matches (id, mode, status, created_at)
      VALUES ($1, $2, 'found', CURRENT_DATE)
      `,
      [matchId, mode]
    );

    for (const row of q.rows) {
      await client.query(
        `
        INSERT INTO match_players (match_id, client_id, nickname, accepted, created_at)
        VALUES ($1, $2, $3, FALSE, CURRENT_DATE)
        `,
        [matchId, row.client_id, row.nickname]
      );

      await client.query(
        `
        UPDATE queue_entries
        SET status = 'match_found',
            match_id = $1,
            updated_at = CURRENT_DATE
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
          updated_at = CURRENT_DATE
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
  try {
    await pool.query("SELECT 1");
    res.json({
      ok: true,
      status: "online",
      timestamp: Date.now(),
      database: "connected"
    });
  } catch (err) {
    console.error("health db error:", err);
    res.status(500).json({
      ok: false,
      status: "degraded",
      timestamp: Date.now(),
      database: "disconnected"
    });
  }
});

app.get("/version", (req, res) => {
  res.json({
    ok: true,
    version: launcherConfig.latestVersion,
    minSupportedVersion: launcherConfig.minSupportedVersion
  });
});

app.get("/motd", (req, res) => {
  res.json({
    ok: true,
    motd: launcherConfig.motd
  });
});

app.get("/config", (req, res) => {
  res.json({
    ok: true,
    config: launcherConfig
  });
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

    const { clientId, nickname, mode } = req.body;

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
      INSERT INTO queue_entries (client_id, nickname, mode, status, match_id, joined_at, updated_at)
      VALUES ($1, $2, $3, 'searching', NULL, CURRENT_DATE, CURRENT_DATE)
      ON CONFLICT (client_id)
      DO UPDATE SET
        nickname = EXCLUDED.nickname,
        mode = EXCLUDED.mode,
        status = 'searching',
        match_id = NULL,
        updated_at = CURRENT_DATE
      `,
      [clientId, nickname, mode]
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
      error: "internal_error",
      details: err.message
    });
  }
});

app.post("/queue/leave", async (req, res) => {
  try {
    const { clientId } = req.body;

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

    res.json({
      ok: true
    });
  } catch (err) {
    console.error("leave error:", err);
    res.status(500).json({
      ok: false,
      error: "internal_error",
      details: err.message
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
    const matchStatus = matchInfo.rows[0]?.status || "found";
    const mode = matchInfo.rows[0]?.mode || row.mode;

    return res.json({
      ok: true,
      state: row.status,
      matchId: row.match_id,
      mode,
      matchStatus,
      totalPlayers,
      acceptedPlayers
    });
  } catch (err) {
    console.error("status error:", err);
    res.status(500).json({
      ok: false,
      error: "internal_error",
      details: err.message
    });
  }
});

app.post("/match/accept", async (req, res) => {
  try {
    const { clientId, matchId } = req.body;

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
      WHERE client_id = $1 AND match_id = $2
      `,
      [clientId, matchId]
    );

    await recomputeMatchStatus(matchId);

    res.json({
      ok: true
    });
  } catch (err) {
    console.error("accept error:", err);
    res.status(500).json({
      ok: false,
      error: "internal_error",
      details: err.message
    });
  }
});

app.post("/match/decline", async (req, res) => {
  try {
    const { clientId, matchId } = req.body;

    if (!clientId || !matchId) {
      return res.status(400).json({
        ok: false,
        error: "missing_fields"
      });
    }

    await pool.query(
      `
      UPDATE matches
      SET status = 'cancelled'
      WHERE id = $1
      `,
      [matchId]
    );

    await pool.query(
      `
      DELETE FROM queue_entries
      WHERE match_id = $1
      `,
      [matchId]
    );

    await pool.query(
      `
      DELETE FROM match_players
      WHERE match_id = $1
      `,
      [matchId]
    );

    res.json({
      ok: true
    });
  } catch (err) {
    console.error("decline error:", err);
    res.status(500).json({
      ok: false,
      error: "internal_error",
      details: err.message
    });
  }
});

app.get("/match/:matchId", async (req, res) => {
  try {
    const matchId = req.params.matchId;

    const match = await pool.query(
      `
      SELECT id, mode, status, created_at
      FROM matches
      WHERE id = $1
      LIMIT 1
      `,
      [matchId]
    );

    if (match.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "match_not_found"
      });
    }

    const players = await pool.query(
      `
      SELECT client_id, nickname, accepted
      FROM match_players
      WHERE match_id = $1
      ORDER BY id ASC
      `,
      [matchId]
    );

    res.json({
      ok: true,
      match: match.rows[0],
      players: players.rows
    });
  } catch (err) {
    console.error("match get error:", err);
    res.status(500).json({
      ok: false,
      error: "internal_error",
      details: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`TRUST backend running on port ${PORT}`);
});
