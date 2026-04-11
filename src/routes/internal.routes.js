const express = require('express');
const { ok, fail } = require('../utils/http');
const {
  heartbeatServer,
  getAssignedMatchForServer,
  markMatchLiveForServer,
  submitMatchResult
} = require('../services/matchService');

const router = express.Router();

function getServerToken(req) {
  const headerToken = req.get('x-server-token');
  const auth = req.get('authorization') || '';
  if (headerToken) return headerToken;
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return (req.body && req.body.serverToken) || req.query.serverToken || null;
}

router.use((req, res, next) => {
  const serverToken = getServerToken(req);
  if (!serverToken) return fail(res, 401, 'missing_server_token');
  req.serverToken = serverToken;
  next();
});

router.post('/server/heartbeat', async (req, res) => {
  try {
    const server = await heartbeatServer(req.serverToken, req.body || {});
    return ok(res, {
      server: {
        id: server.id,
        name: server.name,
        host: server.host,
        port: server.port,
        status: server.status,
        region: server.region,
        lastHeartbeatAt: server.last_heartbeat_at
      }
    });
  } catch (err) {
    return fail(res, 400, err.message || 'heartbeat_failed');
  }
});

router.get('/server/heartbeat-simple', async (req, res) => {
  try {
    const server = await heartbeatServer(req.serverToken, req.query || {});
    return res.type('text/plain').send(`ok=1\nstatus=${server.status}\n`);
  } catch (err) {
    return res.status(400).type('text/plain').send(`ok=0\nerror=${err.message || 'heartbeat_failed'}\n`);
  }
});

router.get('/server/match-config', async (req, res) => {
  try {
    const match = await getAssignedMatchForServer(req.serverToken);
    return ok(res, { match });
  } catch (err) {
    return fail(res, 400, err.message || 'match_config_failed');
  }
});

router.get('/server/match-config-text', async (req, res) => {
  try {
    const match = await getAssignedMatchForServer(req.serverToken);
    if (!match) {
      return res.type('text/plain').send('ok=1\nactive=0\n');
    }

    const lines = [
      'ok=1',
      'active=1',
      `match_id=${match.matchId}`,
      `status=${match.status}`,
      `map=${match.map || ''}`,
      `team_a_name=${match.teamAName || 'Team A'}`,
      `team_b_name=${match.teamBName || 'Team B'}`
    ];

    for (const player of match.players) {
      const safeName = String(player.nickname || 'Player').replace(/[\r\n|]/g, ' ');
      lines.push(`player=${player.steamId64}|${safeName}|${player.team}`);
    }

    return res.type('text/plain').send(lines.join('\n') + '\n');
  } catch (err) {
    return res.status(400).type('text/plain').send(`ok=0\nerror=${err.message || 'match_config_failed'}\n`);
  }
});

router.post('/server/match-ready', async (req, res) => {
  try {
    const { matchId } = req.body || {};
    if (!matchId) return fail(res, 400, 'missing_match_id');
    const match = await markMatchLiveForServer(req.serverToken, matchId);
    return ok(res, { match });
  } catch (err) {
    return fail(res, 400, err.message || 'match_ready_failed');
  }
});

router.get('/server/match-ready-simple', async (req, res) => {
  try {
    const { matchId } = req.query || {};
    if (!matchId) return res.status(400).type('text/plain').send('ok=0\nerror=missing_match_id\n');
    const match = await markMatchLiveForServer(req.serverToken, matchId);
    return res.type('text/plain').send(`ok=1\nmatch_id=${match.public_match_id}\nstatus=${match.status}\n`);
  } catch (err) {
    return res.status(400).type('text/plain').send(`ok=0\nerror=${err.message || 'match_ready_failed'}\n`);
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
      resultSource: 'server_plugin',
      serverToken: req.serverToken
    });
    return ok(res, result);
  } catch (err) {
    return fail(res, 400, err.message || 'result_submit_failed');
  }
});

router.get('/server/result-simple', async (req, res) => {
  try {
    const { matchId, winnerTeam, teamAScore, teamBScore, map } = req.query || {};
    if (!matchId || !winnerTeam) return res.status(400).type('text/plain').send('ok=0\nerror=missing_fields\n');
    const result = await submitMatchResult({
      publicMatchId: matchId,
      winnerTeam,
      teamAScore: Number(teamAScore || 0),
      teamBScore: Number(teamBScore || 0),
      mapName: map || null,
      resultSource: 'server_plugin',
      serverToken: req.serverToken
    });
    return res.type('text/plain').send(`ok=1\nalready_finished=${result.alreadyFinished ? 1 : 0}\n`);
  } catch (err) {
    return res.status(400).type('text/plain').send(`ok=0\nerror=${err.message || 'result_submit_failed'}\n`);
  }
});

module.exports = router;
