const express = require('express');
const { query, withTransaction } = require('../db');
const { ok, fail } = require('../utils/http');
const { submitMatchResult } = require('../services/matchService');
const { logMatchEvent } = require('../services/matchRoomService');

const router = express.Router();
const RECONNECT_GRACE_SECONDS = Number(process.env.RECONNECT_GRACE_SECONDS || 90);

async function getServerByToken(token) {
  if (!token) return null;
  const result = await query(`SELECT * FROM server_instances WHERE server_token = $1 LIMIT 1`, [token]);
  return result.rows[0] || null;
}
async function getActiveMatchForServer(serverId) {
  const result = await query(
    `SELECT * FROM matches WHERE server_id = $1 AND status IN ('server_assigned', 'live') ORDER BY created_at DESC LIMIT 1`,
    [serverId]
  );
  return result.rows[0] || null;
}
async function getMatchPlayers(matchId) {
  const result = await query(
    `SELECT u.steam_id, u.persona_name, mp.team, mp.slot_index, mp.connection_state,
            mp.joined_server_at, mp.disconnected_at, mp.reconnect_expires_at, mp.abandoned_at
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
    shortdust: 'de_shortdust', lake: 'de_lake', overpass: 'de_overpass', vertigo: 'de_vertigo', nuke: 'de_nuke',
    de_shortdust: 'de_shortdust', de_lake: 'de_lake', de_overpass: 'de_overpass', de_vertigo: 'de_vertigo', de_nuke: 'de_nuke'
  };
  return map[raw] || 'de_dust2';
}
function buildConfigText(match, players) {
  const lines = [];
  if (!match) return 'active=0\n';
  lines.push('active=1');
  lines.push(`match_id=${match.public_match_id}`);
  lines.push(`map=${mapLabelToServerMap(match.map_name)}`);
  lines.push(`status=${match.status}`);
  lines.push('team_a_name=Team A');
  lines.push('team_b_name=Team B');
  for (const player of players) lines.push(`player=${player.steam_id}|${player.persona_name}|${player.team}`);
  return `${lines.join('\n')}\n`;
}
async function refreshReconnectTimeoutState(serverId) {
  if (!serverId) return;
  const result = await query(
    `SELECT COUNT(*)::int AS expired_count
     FROM match_players mp
     JOIN matches m ON m.id = mp.match_id
     WHERE m.server_id = $1
       AND m.status = 'live'
       AND mp.connection_state = 'disconnected'
       AND mp.reconnect_expires_at IS NOT NULL
       AND mp.reconnect_expires_at <= NOW()
       AND mp.abandoned_at IS NULL`,
    [serverId]
  );
  const expiredCount = Number(result.rows[0]?.expired_count || 0);
  if (expiredCount > 0) {
    console.log(`[server-sync] reconnect grace expired for ${expiredCount} player(s) on server ${serverId}; lifecycle tick will register abandon.`);
  }
}

router.use(async (req, res, next) => {
  try {
    const server = await getServerByToken(req.get('x-server-token') || '');
    if (!server) return fail(res, 401, 'invalid_server_token');
    req.trustServer = server;
    return next();
  } catch (err) { return next(err); }
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
    await refreshReconnectTimeoutState(req.trustServer.id);
    return ok(res, { heartbeat: true });
  } catch (err) { return fail(res, 400, err.message || 'heartbeat_failed'); }
});

router.get('/server/match-config-text', async (req, res) => {
  try {
    await refreshReconnectTimeoutState(req.trustServer.id);
    const match = await getActiveMatchForServer(req.trustServer.id);
    if (!match) return res.type('text/plain').send('active=0\n');
    const players = await getMatchPlayers(match.id);
    return res.type('text/plain').send(buildConfigText(match, players));
  } catch (err) { return fail(res, 400, err.message || 'match_config_failed'); }
});

router.get('/server/match-ready-simple', async (req, res) => {
  try {
    const { matchId } = req.query;
    if (!matchId) return fail(res, 400, 'missing_match_id');
    await withTransaction(async (client) => {
      const matchRes = await client.query(
        `UPDATE matches
         SET status = 'live', started_at = COALESCE(started_at, NOW()), finish_reason = NULL
         WHERE public_match_id = $1
           AND server_id = $2
           AND status = 'server_assigned'
           AND (connect_expires_at IS NULL OR connect_expires_at > NOW())
         RETURNING id`,
        [String(matchId), req.trustServer.id]
      );
      const match = matchRes.rows[0];
      if (match) {
        await client.query(`UPDATE server_instances SET status = 'live', last_heartbeat_at = NOW() WHERE id = $1`, [req.trustServer.id]);
        await logMatchEvent(client, { matchId: match.id, eventType: 'live_started', phase: 'live', title: 'Live started', description: 'Сервер подтвердил старт live-матча.' });
      }
    });
    return ok(res, { ready: true });
  } catch (err) { return fail(res, 400, err.message || 'match_ready_failed'); }
});

router.post('/server/player-connected', async (req, res) => {
  try {
    const { matchId, steamId } = req.body || {};
    if (!matchId || !steamId) return fail(res, 400, 'missing_fields');
    const result = await withTransaction(async (client) => {
      const matchRes = await client.query(
        `SELECT id, public_match_id, status FROM matches WHERE public_match_id = $1 AND server_id = $2 LIMIT 1 FOR UPDATE`,
        [String(matchId), req.trustServer.id]
      );
      const match = matchRes.rows[0];
      if (!match) throw new Error('match_not_found');
      if (!['server_assigned', 'live'].includes(match.status)) throw new Error('match_not_connecting');
      const updateRes = await client.query(
        `UPDATE match_players mp
           SET joined_server_at = COALESCE(joined_server_at, NOW()), connected_at = COALESCE(connected_at, NOW()),
               disconnected_at = NULL, reconnect_expires_at = NULL,
               abandoned_at = CASE WHEN mp.connection_state = 'abandoned' THEN NULL ELSE mp.abandoned_at END,
               connection_state = 'connected'
         FROM users u
         WHERE u.id = mp.user_id AND mp.match_id = $1 AND u.steam_id = $2
         RETURNING mp.user_id, u.persona_name, mp.connected_at`,
        [match.id, String(steamId)]
      );
      const player = updateRes.rows[0];
      if (!player) throw new Error('player_not_in_match');
      await logMatchEvent(client, {
        matchId: match.id,
        eventType: 'player_connected',
        phase: match.status === 'live' ? 'live' : 'connect',
        actorUserId: player.user_id,
        actorSteamId: String(steamId),
        title: 'Player connected',
        description: `${player.persona_name || 'Игрок'} подключился к серверу.`
      });
      const connectedRes = await client.query(`SELECT COUNT(*) FILTER (WHERE connection_state = 'connected')::int AS connected_count, COUNT(*)::int AS total_count FROM match_players WHERE match_id = $1`, [match.id]);
      const connectedCount = connectedRes.rows[0].connected_count;
      const totalCount = connectedRes.rows[0].total_count;
      if (connectedCount === totalCount && match.status === 'server_assigned') {
        const promotedRes = await client.query(
          `UPDATE matches
           SET status = 'live', started_at = COALESCE(started_at, NOW())
           WHERE id = $1
             AND status = 'server_assigned'
             AND (connect_expires_at IS NULL OR connect_expires_at > NOW())
           RETURNING id`,
          [match.id]
        );
        if (promotedRes.rowCount > 0) {
          await client.query(`UPDATE server_instances SET status = 'live', last_heartbeat_at = NOW() WHERE id = $1`, [req.trustServer.id]);
          await logMatchEvent(client, { matchId: match.id, eventType: 'all_connected', phase: 'connect', title: 'All players connected', description: 'Все 4 игрока находятся на сервере.' });
        }
      }
      return { connectedCount, totalCount };
    });
    return ok(res, result);
  } catch (err) { return fail(res, 400, err.message || 'player_connected_failed'); }
});

router.post('/server/player-disconnected', async (req, res) => {
  try {
    const { matchId, steamId } = req.body || {};
    if (!matchId || !steamId) return fail(res, 400, 'missing_fields');
    const result = await withTransaction(async (client) => {
      const matchRes = await client.query(`SELECT id, public_match_id, status FROM matches WHERE public_match_id = $1 AND server_id = $2 LIMIT 1 FOR UPDATE`, [String(matchId), req.trustServer.id]);
      const match = matchRes.rows[0];
      if (!match) throw new Error('match_not_found');
      if (match.status === 'finished') throw new Error('match_already_finished');
      const updateRes = await client.query(
        `UPDATE match_players mp
           SET disconnected_at = NOW(), reconnect_expires_at = NOW() + make_interval(secs => $3::int), connection_state = 'disconnected'
         FROM users u
         WHERE u.id = mp.user_id AND mp.match_id = $1 AND u.steam_id = $2
         RETURNING mp.user_id, u.persona_name, mp.reconnect_expires_at`,
        [match.id, String(steamId), RECONNECT_GRACE_SECONDS]
      );
      const player = updateRes.rows[0];
      if (!player) throw new Error('player_not_in_match');
      await logMatchEvent(client, {
        matchId: match.id,
        eventType: 'player_disconnected',
        phase: match.status === 'live' ? 'live' : 'connect',
        actorUserId: player.user_id,
        actorSteamId: String(steamId),
        title: 'Player disconnected',
        description: `${player.persona_name || 'Игрок'} отключился. Открыт reconnect grace.`
      });
      return { reconnectGraceSeconds: RECONNECT_GRACE_SECONDS, reconnectExpiresAt: player.reconnect_expires_at };
    });
    return ok(res, result);
  } catch (err) { return fail(res, 400, err.message || 'player_disconnected_failed'); }
});

router.get('/server/result-config-text', async (req, res) => {
  try {
    const match = await getActiveMatchForServer(req.trustServer.id);
    if (!match) return res.type('text/plain').send('active=0\n');
    return res.type('text/plain').send(`active=1\nmatch_id=${match.public_match_id}\nmap=${mapLabelToServerMap(match.map_name)}\n`);
  } catch (err) { return fail(res, 400, err.message || 'result_config_failed'); }
});

router.post('/server/result', async (req, res) => {
  try {
    const { matchId, winnerTeam, teamAScore, teamBScore, map } = req.body || {};
    if (!matchId || !winnerTeam) return fail(res, 400, 'missing_fields');
    const result = await submitMatchResult({ publicMatchId: String(matchId), winnerTeam: String(winnerTeam), teamAScore: Number(teamAScore || 0), teamBScore: Number(teamBScore || 0), mapName: String(map || ''), resultSource: 'server_plugin' });
    return ok(res, result);
  } catch (err) { return fail(res, 400, err.message || 'result_submit_failed'); }
});

module.exports = router;
