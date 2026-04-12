const express = require('express');
const { query, withTransaction } = require('../db');
const { ok, fail } = require('../../utils/http');
const { submitMatchResult } = require('../../services/matchService');

const router = express.Router();

async function getServerByToken(token) {
  if (!token) return null;
  const result = await query(
    `SELECT * FROM server_instances WHERE server_token = $1 LIMIT 1`,
    [token]
  );
  return result.rows[0] || null;
}

async function getActiveMatchForServer(serverId) {
  const result = await query(
    `SELECT *
     FROM matches
     WHERE server_id = $1
       AND status IN ('server_assigned', 'live')
     ORDER BY created_at DESC
     LIMIT 1`,
    [serverId]
  );
  return result.rows[0] || null;
}

async function getMatchPlayers(matchId) {
  const result = await query(
    `SELECT u.steam_id,
            u.persona_name,
            mp.team,
            mp.slot_index
     FROM match_players mp
     JOIN users u ON u.id = mp.user_id
     WHERE mp.match_id = $1
     ORDER BY mp.team ASC, mp.slot_index ASC`,
    [matchId]
  );
  return result.rows;
}

function mapLabelToServerMap(input) {
  const raw = String(input || '').trim().toLowerCase();
  const map = {
    shortdust: 'de_shortdust',
    lake: 'de_lake',
    overpass: 'de_overpass',
    vertigo: 'de_vertigo',
    nuke: 'de_nuke',
    de_shortdust: 'de_shortdust',
    de_lake: 'de_lake',
    de_overpass: 'de_overpass',
    de_vertigo: 'de_vertigo',
    de_nuke: 'de_nuke'
  };
  return map[raw] || 'de_dust2';
}

function buildConfigText(match, players) {
  const lines = [];
  if (!match) {
    lines.push('active=0');
    return `${lines.join('\n')}\n`;
  }

  lines.push('active=1');
  lines.push(`match_id=${match.public_match_id}`);
  lines.push(`map=${mapLabelToServerMap(match.map_name)}`);
  lines.push('team_a_name=Team A');
  lines.push('team_b_name=Team B');

  for (const player of players) {
    lines.push(`player=${player.steam_id}|${player.persona_name}|${player.team}`);
  }

  return `${lines.join('\n')}\n`;
}

router.use(async (req, res, next) => {
  try {
    const serverToken = req.get('x-server-token') || '';
    const server = await getServerByToken(serverToken);
    if (!server) return fail(res, 401, 'invalid_server_token');
    req.trustServer = server;
    return next();
  } catch (err) {
    return next(err);
  }
});

router.get('/server/heartbeat-simple', async (req, res) => {
  try {
    const status = String(req.query.status || 'idle');
    await query(
      `UPDATE server_instances
       SET status = CASE WHEN $2 IN ('idle','reserved','live','offline') THEN $2 ELSE status END,
           last_heartbeat_at = NOW()
       WHERE id = $1`,
      [req.trustServer.id, status]
    );
    return ok(res, { heartbeat: true });
  } catch (err) {
    return fail(res, 400, err.message || 'heartbeat_failed');
  }
});

router.get('/server/match-config-text', async (req, res) => {
  try {
    const match = await getActiveMatchForServer(req.trustServer.id);
    if (!match) {
      res.type('text/plain').send('active=0\n');
      return;
    }

    const players = await getMatchPlayers(match.id);
    res.type('text/plain').send(buildConfigText(match, players));
  } catch (err) {
    return fail(res, 400, err.message || 'match_config_failed');
  }
});

router.get('/server/match-ready-simple', async (req, res) => {
  try {
    const { matchId } = req.query;
    if (!matchId) return fail(res, 400, 'missing_match_id');

    await query(
      `UPDATE matches
       SET status = 'live', started_at = COALESCE(started_at, NOW())
       WHERE public_match_id = $1 AND server_id = $2`,
      [String(matchId), req.trustServer.id]
    );

    await query(
      `UPDATE server_instances
       SET status = 'live', last_heartbeat_at = NOW()
       WHERE id = $1`,
      [req.trustServer.id]
    );

    return ok(res, { ready: true });
  } catch (err) {
    return fail(res, 400, err.message || 'match_ready_failed');
  }
});

router.get('/server/result-config-text', async (req, res) => {
  try {
    const match = await getActiveMatchForServer(req.trustServer.id);
    if (!match) {
      res.type('text/plain').send('active=0\n');
      return;
    }
    res
      .type('text/plain')
      .send(`active=1\nmatch_id=${match.public_match_id}\nmap=${mapLabelToServerMap(match.map_name)}\n`);
  } catch (err) {
    return fail(res, 400, err.message || 'result_config_failed');
  }
});

router.post('/server/result', async (req, res) => {
  try {
    const { matchId, winnerTeam, teamAScore, teamBScore, map } = req.body || {};
    if (!matchId || !winnerTeam) return fail(res, 400, 'missing_fields');
    const result = await submitMatchResult({
      publicMatchId: matchId,
      winnerTeam,
      teamAScore: Number(teamAScore || 0),
      teamBScore: Number(teamBScore || 0),
      mapName: map || null,
      resultSource: 'server_plugin'
    });
    return ok(res, result);
  } catch (err) {
    return fail(res, 400, err.message || 'result_submit_failed');
  }
});

module.exports = router;
