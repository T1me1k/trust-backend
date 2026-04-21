const config = require('../config');
const { query, withTransaction } = require('../db');
const { applySimpleMatchElo } = require('./eloService');
const { setPresence } = require('./accountService');
const { logMatchEvent, normalizeFinishReason, finishReasonLabel, FINISH_REASONS } = require('./matchRoomService');

const MAP_POOL = ['shortdust', 'lake', 'overpass', 'vertigo', 'nuke'];
const ISSUE_REASONS = [
  'server_not_responding',
  'cannot_connect',
  'player_not_connecting',
  'match_stuck',
  'result_not_recorded',
  'other'
];

function determineSelectedMap(votes) {
  if (!votes.length) return null;
  const counts = new Map();
  for (const vote of votes) counts.set(vote, (counts.get(vote) || 0) + 1);
  let bestMap = null;
  let bestCount = -1;
  for (const map of MAP_POOL) {
    const count = counts.get(map) || 0;
    if (count > bestCount) {
      bestCount = count;
      bestMap = map;
    }
  }
  return bestMap;
}

function toIso(value) { return value ? new Date(value).toISOString() : null; }
function timeRemainingSec(expiresAt) {
  if (!expiresAt) return null;
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000));
}
function inferPhase(status) {
  switch (status) {
    case 'pending_acceptance': return 'accept';
    case 'map_voting': return 'map';
    case 'server_assigned': return 'connect';
    case 'live': return 'live';
    case 'finished': return 'finished';
    case 'cancelled': return 'cancelled';
    default: return 'waiting';
  }
}
function getCurrentDeadline(room) {
  if (room.phase === 'accept') return room.deadlines.acceptRemainingSec;
  if (room.phase === 'connect') return room.deadlines.connectRemainingSec;
  if (room.me?.reconnectRemainingSec) return room.me.reconnectRemainingSec;
  return null;
}
function buildPhaseTimeline(match) {
  const current = inferPhase(match.status);
  const isCancelled = current === 'cancelled';
  const steps = [
    { key: 'accept', title: 'Accept', description: 'Все 4 игрока должны принять матч.' },
    { key: 'map', title: 'Map', description: 'Игроки выбирают карту из пула TRUST.' },
    { key: 'connect', title: 'Connect', description: 'Подключение к назначенному серверу.' },
    { key: 'live', title: 'Live', description: 'Матч идёт, reconnect grace активен.' },
    {
      key: isCancelled ? 'cancelled' : 'finished',
      title: isCancelled ? 'Cancelled' : 'Finished',
      description: isCancelled
        ? (finishReasonLabel(match.finish_reason || match.result_source) || 'Матч отменён.')
        : 'Результат записан и доступен игрокам.'
    }
  ];
  const order = ['accept', 'map', 'connect', 'live', isCancelled ? 'cancelled' : 'finished'];
  const currentIndex = order.indexOf(current);
  return steps.map((step, index) => ({
    ...step,
    state: current === step.key ? 'current' : index < currentIndex ? 'done' : 'upcoming'
  }));
}

function buildPlayerView(row, myPartyId) {
  const sameParty = !!row.party_id && !!myPartyId && row.party_id === myPartyId;
  const connectionState = row.connection_state || 'pending_connect';
  let statusLabel = 'Pending';
  let statusTone = 'idle';
  if (connectionState === 'connected') { statusLabel = 'Connected'; statusTone = 'ok'; }
  else if (connectionState === 'disconnected') { statusLabel = 'Offline'; statusTone = 'warn'; }
  else if (connectionState === 'abandoned') { statusLabel = 'Abandon'; statusTone = 'danger'; }
  else if (connectionState === 'pending_connect' || row.accepted_at) { statusLabel = row.accepted_at ? 'Accepted' : 'Pending'; statusTone = row.accepted_at ? 'ok' : 'idle'; }

  return {
    userId: row.user_id,
    nickname: row.nickname,
    avatarUrl: row.avatar_url,
    elo: Number(row.elo_2v2 || 100),
    elo2v2: Number(row.elo_2v2 || 100),
    team: row.team,
    slotIndex: Number(row.slot_index || 0),
    partyId: row.party_id || null,
    partyMarker: sameParty ? 'DUO' : null,
    accepted: !!row.accepted_at,
    acceptedAt: toIso(row.accepted_at),
    mapVote: row.map_vote || null,
    connectedAt: toIso(row.connected_at),
    joinedServerAt: toIso(row.joined_server_at),
    connectionState,
    disconnectedAt: toIso(row.disconnected_at),
    reconnectExpiresAt: toIso(row.reconnect_expires_at),
    reconnectRemainingSec: timeRemainingSec(row.reconnect_expires_at),
    abandonedAt: toIso(row.abandoned_at),
    statusLabel,
    statusTone,
    isOffline: connectionState === 'disconnected',
    isReconnecting: connectionState === 'disconnected' && !!row.reconnect_expires_at,
    isAbandoned: connectionState === 'abandoned' || !!row.abandoned_at
  };
}

async function getMatchEvents(matchId, limit = 50) {
  const result = await query(
    `SELECT me.event_type, me.phase, me.title, me.description, me.created_at,
            me.actor_user_id, me.actor_steam_id, me.metadata,
            u.persona_name AS actor_nickname
     FROM match_events me
     LEFT JOIN users u ON u.id = me.actor_user_id
     WHERE me.match_id = $1
     ORDER BY me.created_at ASC
     LIMIT $2`,
    [matchId, limit]
  );
  return result.rows.map((row) => ({
    type: row.event_type,
    phase: row.phase,
    title: row.title,
    description: row.description,
    createdAt: toIso(row.created_at),
    actor: row.actor_user_id ? {
      userId: row.actor_user_id,
      steamId: row.actor_steam_id,
      nickname: row.actor_nickname || null
    } : null,
    metadata: row.metadata || null
  }));
}

function buildRoomSummary(match, players, events, myUserId) {
  const acceptedCount = players.filter((p) => p.accepted).length;
  const connectedCount = players.filter((p) => p.connectionState === 'connected').length;
  const votes = players.map((p) => p.mapVote).filter(Boolean);
  const myPlayer = players.find((p) => p.userId === myUserId) || null;
  const room = {
    matchId: match.public_match_id,
    publicMatchId: match.public_match_id,
    mode: match.mode,
    status: match.status,
    phase: inferPhase(match.status),
    phaseLabel: inferPhase(match.status).toUpperCase(),
    mapName: match.map_name || null,
    finishReason: normalizeFinishReason(match.finish_reason || match.result_source, match.status === 'cancelled' ? 'technical_cancel' : 'finished'),
    finishReasonLabel: finishReasonLabel(match.finish_reason || match.result_source),
    finalMessage: match.final_message || null,
    cancelledReason: match.cancel_reason || null,
    server: {
      id: match.server_id || null,
      name: match.server_name || 'EU-1',
      ip: match.server_ip || null,
      port: match.server_port || null,
      password: match.server_password || null,
      region: match.server_region || 'EU',
      connectCommand: match.server_ip && match.server_port
        ? `connect ${match.server_ip}:${match.server_port}${match.server_password ? `; password ${match.server_password}` : ''}`
        : null
    },
    score: {
      teamA: Number(match.team_a_score || 0),
      teamB: Number(match.team_b_score || 0),
      winnerTeam: match.winner_team || null
    },
    counts: {
      totalPlayers: players.length,
      accepted: acceptedCount,
      connected: connectedCount,
      votes: votes.length
    },
    me: myPlayer,
    teams: {
      teamA: players.filter((p) => p.team === 'A').sort((a, b) => a.slotIndex - b.slotIndex),
      teamB: players.filter((p) => p.team === 'B').sort((a, b) => a.slotIndex - b.slotIndex)
    },
    deadlines: {
      acceptExpiresAt: toIso(match.accept_expires_at),
      acceptRemainingSec: timeRemainingSec(match.accept_expires_at),
      connectExpiresAt: toIso(match.connect_expires_at),
      connectRemainingSec: timeRemainingSec(match.connect_expires_at),
      reconnectExpiresAt: myPlayer?.reconnectExpiresAt || null,
      reconnectRemainingSec: myPlayer?.reconnectRemainingSec || null
    },
    actions: {
      canAccept: inferPhase(match.status) === 'accept' && !!myPlayer && !myPlayer.accepted,
      canVoteMap: ['map_voting', 'server_assigned'].includes(match.status) && !!myPlayer && !match.map_name,
      canConnect: ['server_assigned', 'live'].includes(match.status) && !!match.server_ip && !!match.server_port,
      canCopyIp: !!match.server_ip && !!match.server_port,
      canCopyCommand: !!match.server_ip && !!match.server_port,
      canOpenIssueModal: ['connect', 'live', 'finished'].includes(inferPhase(match.status))
    },
    progressTimeline: buildPhaseTimeline(match),
    eventTimeline: events,
    currentDeadlineSec: null
  };
  room.currentDeadlineSec = getCurrentDeadline(room);
  room.statusText = room.phase === 'accept'
    ? `${acceptedCount}/${players.length} приняли матч`
    : room.phase === 'map'
      ? `${votes.length}/${players.length} голосов по карте`
      : room.phase === 'connect'
        ? `${connectedCount}/${players.length} подключились к серверу`
        : room.phase === 'live'
          ? 'Матч LIVE'
          : room.finishReasonLabel;
  return room;
}

async function getCurrentMatchByUserId(userId) {
  const result = await query(
    `SELECT m.id, m.public_match_id, m.mode, m.status, m.map_name, m.server_ip, m.server_port, m.server_password,
            m.team_a_score, m.team_b_score, m.winner_team, m.server_id, m.accept_expires_at,
            m.map_voting_started_at, m.map_voting_finished_at, m.connect_expires_at, m.started_at, m.finished_at,
            m.result_source, m.finish_reason, m.cancel_reason, m.final_message,
            si.name AS server_name, si.region AS server_region,
            mp.team, mp.accepted_at AS player_accepted_at, mp.map_vote AS player_map_vote,
            mp.connected_at AS player_connected_at, mp.connection_state AS player_connection_state,
            mp.reconnect_expires_at AS player_reconnect_expires_at, mp.abandoned_at AS player_abandoned_at,
            mp.result_seen_at AS player_result_seen_at, mp.party_id AS player_party_id
     FROM match_players mp
     JOIN matches m ON m.id = mp.match_id
     LEFT JOIN server_instances si ON si.id::text = m.server_id
     WHERE mp.user_id = $1
       AND (
         m.status = 'map_voting'
         OR m.status = 'live'
         OR (m.status = 'pending_acceptance' AND (m.accept_expires_at IS NULL OR m.accept_expires_at > NOW()))
         OR (m.status = 'server_assigned' AND (m.connect_expires_at IS NULL OR m.connect_expires_at > NOW()))
         OR (m.status = 'cancelled' AND (m.finished_at IS NULL OR m.finished_at >= NOW() - INTERVAL '2 hours'))
       )
     ORDER BY COALESCE(m.finished_at, m.created_at) DESC
     LIMIT 1`,
    [userId]
  );
  const match = result.rows[0] || null;
  if (!match) return null;

  const playersResult = await query(
    `SELECT u.persona_name AS nickname, u.avatar_full_url AS avatar_url, p.elo_2v2,
            mp.team, mp.slot_index, mp.accepted_at, mp.map_vote, mp.user_id, mp.party_id,
            mp.connected_at, mp.joined_server_at, mp.connection_state,
            mp.disconnected_at, mp.reconnect_expires_at, mp.abandoned_at
     FROM match_players mp
     JOIN users u ON u.id = mp.user_id
     LEFT JOIN player_profiles p ON p.user_id = mp.user_id
     WHERE mp.match_id = $1
     ORDER BY mp.team ASC, mp.slot_index ASC`,
    [match.id]
  );
  const players = playersResult.rows.map((row) => buildPlayerView(row, match.player_party_id));
  const events = await getMatchEvents(match.id, 64);
  const room = buildRoomSummary(match, players, events, userId);

  return {
    matchId: match.public_match_id,
    publicMatchId: match.public_match_id,
    mode: match.mode,
    status: match.status,
    phase: room.phase,
    statusText: room.statusText,
    mapName: match.map_name,
    serverIp: match.server_ip,
    serverPort: match.server_port,
    serverPassword: match.server_password,
    serverName: match.server_name || 'EU-1',
    serverRegion: match.server_region || 'EU',
    teamAScore: Number(match.team_a_score || 0),
    teamBScore: Number(match.team_b_score || 0),
    winnerTeam: match.winner_team,
    team: match.team,
    accepted: !!match.player_accepted_at,
    acceptedCount: room.counts.accepted,
    connectedCount: room.counts.connected,
    totalPlayers: players.length,
    mapVote: match.player_map_vote || null,
    mapVotesCount: room.counts.votes,
    mapPool: MAP_POOL,
    players,
    room,
    acceptExpiresAt: toIso(match.accept_expires_at),
    acceptRemainingSec: timeRemainingSec(match.accept_expires_at),
    connectExpiresAt: toIso(match.connect_expires_at),
    connectRemainingSec: timeRemainingSec(match.connect_expires_at),
    startedAt: toIso(match.started_at),
    finishedAt: toIso(match.finished_at),
    finishReason: room.finishReason,
    eventTimeline: events,
    timeline: room.progressTimeline
  };
}

async function getMatchRoomByPublicId(userId, publicMatchId) {
  const current = await getCurrentMatchByUserId(userId);
  if (!current || current.publicMatchId !== publicMatchId) return null;
  return current.room;
}

async function getMatchHistory(userId, limit = 8) {
  const result = await query(
    `SELECT m.public_match_id, m.mode, m.status, m.map_name, m.team_a_score, m.team_b_score, m.winner_team, m.finished_at,
            m.finish_reason, mp.team, mp.elo_before, mp.elo_after, mp.elo_delta, mp.result
     FROM match_players mp
     JOIN matches m ON m.id = mp.match_id
     WHERE mp.user_id = $1 AND m.status = 'finished'
     ORDER BY m.finished_at DESC NULLS LAST, m.created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return result.rows.map((row) => ({
    ...row,
    finishReason: normalizeFinishReason(row.finish_reason)
  }));
}

async function acceptCurrentMatch(userId, publicMatchId) {
  return withTransaction(async (client) => {
    const current = await client.query(
      `SELECT m.id, m.status, mp.accepted_at
       FROM matches m
       JOIN match_players mp ON mp.match_id = m.id
       WHERE m.public_match_id = $1 AND mp.user_id = $2
       LIMIT 1
       FOR UPDATE`,
      [publicMatchId, userId]
    );
    const row = current.rows[0];
    if (!row) throw new Error('match_not_found');
    if (!['pending_acceptance', 'map_voting', 'server_assigned'].includes(row.status)) throw new Error('match_not_accepting');

    if (!row.accepted_at) {
      await client.query(`UPDATE match_players SET accepted_at = NOW() WHERE match_id = $1 AND user_id = $2`, [row.id, userId]);
      await logMatchEvent(client, {
        matchId: row.id,
        eventType: 'player_accepted',
        phase: 'accept',
        actorUserId: userId,
        title: 'Player accepted',
        description: 'Игрок подтвердил найденный матч.'
      });
    }

    const counts = await client.query(
      `SELECT COUNT(*)::int AS total, COUNT(accepted_at)::int AS accepted
       FROM match_players WHERE match_id = $1`,
      [row.id]
    );
    const total = counts.rows[0].total;
    const accepted = counts.rows[0].accepted;

    if (accepted === total) {
      await client.query(
        `UPDATE matches
         SET status = CASE WHEN map_name IS NULL THEN 'map_voting' ELSE 'server_assigned' END,
             accepted_at = COALESCE(accepted_at, NOW()),
             map_voting_started_at = CASE WHEN map_name IS NULL THEN COALESCE(map_voting_started_at, NOW()) ELSE map_voting_started_at END,
             connect_expires_at = CASE WHEN map_name IS NULL THEN connect_expires_at ELSE COALESCE(connect_expires_at, NOW() + make_interval(secs => $2::int)) END
         WHERE id = $1`,
        [row.id, config.connectTimeoutSeconds]
      );
      await logMatchEvent(client, {
        matchId: row.id,
        eventType: 'all_accepted',
        phase: 'accept',
        title: 'All accepted',
        description: 'Все 4 игрока приняли матч.'
      });
    }

    return { accepted, total };
  });
}

async function submitMapVote(userId, publicMatchId, mapName) {
  if (!MAP_POOL.includes(mapName)) throw new Error('invalid_map');

  return withTransaction(async (client) => {
    const matchResult = await client.query(
      `SELECT m.id, m.status
       FROM matches m
       JOIN match_players mp ON mp.match_id = m.id
       WHERE m.public_match_id = $1 AND mp.user_id = $2
       LIMIT 1
       FOR UPDATE`,
      [publicMatchId, userId]
    );
    const match = matchResult.rows[0];
    if (!match) throw new Error('match_not_found');
    if (!['map_voting', 'server_assigned'].includes(match.status)) throw new Error('map_voting_not_started');

    await client.query(
      `UPDATE match_players
       SET map_vote = $3, map_vote_at = NOW(), accepted_at = COALESCE(accepted_at, NOW())
       WHERE match_id = $1 AND user_id = $2`,
      [match.id, userId, mapName]
    );
    await logMatchEvent(client, {
      matchId: match.id,
      eventType: 'map_vote',
      phase: 'map',
      actorUserId: userId,
      title: 'Map vote submitted',
      description: `Игрок проголосовал за ${mapName}.`,
      metadata: { mapName }
    });

    const players = await client.query(`SELECT map_vote FROM match_players WHERE match_id = $1`, [match.id]);
    const votes = players.rows.map((r) => r.map_vote).filter(Boolean);
    let selectedMap = votes.length >= 4 ? determineSelectedMap(votes) : null;
    if (!selectedMap) {
      const maybeMajority = determineSelectedMap(votes);
      const count = votes.filter((v) => v === maybeMajority).length;
      if (count >= 3) selectedMap = maybeMajority;
    }

    if (selectedMap) {
      await client.query(
        `UPDATE matches
         SET map_name = $2,
             map_voting_finished_at = NOW(),
             selected_map_by = 'player_votes',
             status = 'server_assigned',
             connect_expires_at = COALESCE(connect_expires_at, NOW() + make_interval(secs => $3::int))
         WHERE id = $1`,
        [match.id, selectedMap, config.connectTimeoutSeconds]
      );
      await logMatchEvent(client, {
        matchId: match.id,
        eventType: 'map_selected',
        phase: 'map',
        title: 'Map selected',
        description: `Карта ${selectedMap} выбрана для матча.`,
        metadata: { mapName: selectedMap }
      });
    }

    return { selectedMap };
  });
}

async function submitMatchIssue({ userId, publicMatchId, phase, reason, comment }) {
  const normalizedReason = String(reason || '').trim();
  if (!ISSUE_REASONS.includes(normalizedReason)) throw new Error('invalid_issue_reason');
  const safeComment = String(comment || '').trim().slice(0, 1000) || null;
  const normalizedPhase = ['accept', 'map', 'connect', 'live', 'finished', 'cancelled'].includes(String(phase || '').trim())
    ? String(phase || '').trim()
    : null;

  return withTransaction(async (client) => {
    const matchRes = await client.query(
      `SELECT m.id, m.public_match_id, m.status
       FROM matches m
       JOIN match_players mp ON mp.match_id = m.id
       WHERE m.public_match_id = $1 AND mp.user_id = $2
       LIMIT 1
       FOR UPDATE`,
      [publicMatchId, userId]
    );
    const match = matchRes.rows[0];
    if (!match) throw new Error('match_not_found');

    const insertRes = await client.query(
      `INSERT INTO match_issue_reports (match_id, player_id, phase, reason, comment)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, created_at`,
      [match.id, userId, normalizedPhase || inferPhase(match.status), normalizedReason, safeComment]
    );

    await logMatchEvent(client, {
      matchId: match.id,
      eventType: 'issue_reported',
      phase: normalizedPhase || inferPhase(match.status),
      actorUserId: userId,
      title: 'Problem reported',
      description: safeComment || normalizedReason,
      metadata: { reason: normalizedReason }
    });

    return {
      reportId: insertRes.rows[0].id,
      createdAt: toIso(insertRes.rows[0].created_at)
    };
  });
}

async function submitMatchResult({ publicMatchId, winnerTeam, teamAScore, teamBScore, mapName, resultSource = 'server_plugin' }) {
  const matchResult = await query(`SELECT id, status, server_id, result_source FROM matches WHERE public_match_id = $1 LIMIT 1`, [publicMatchId]);
  const match = matchResult.rows[0];
  if (!match) throw new Error('match_not_found');
  if (match.status === 'finished') return { alreadyFinished: true, duplicate: true, resultSource: match.result_source || null };
  if (!['server_assigned', 'live'].includes(match.status)) throw new Error('match_not_live');

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE matches
       SET status = 'finished', winner_team = $2, team_a_score = $3, team_b_score = $4,
           map_name = COALESCE($5, map_name), result_source = $6, finished_at = NOW(), result_ack_required = TRUE,
           finish_reason = 'finished', final_message = 'Результат записан и доступен в Match Room.'
       WHERE id = $1`,
      [match.id, winnerTeam, teamAScore, teamBScore, mapName || null, resultSource]
    );

    await client.query(`UPDATE match_players SET result_seen_at = NULL WHERE match_id = $1`, [match.id]);
    if (match.server_id) {
      await client.query(`UPDATE server_instances SET status = 'idle', last_heartbeat_at = NOW() WHERE id = $1`, [match.server_id]);
    }
    await logMatchEvent(client, {
      matchId: match.id,
      eventType: 'match_finished',
      phase: 'finished',
      title: 'Match finished',
      description: `Итоговый счёт ${teamAScore}:${teamBScore}.`,
      metadata: { winnerTeam, teamAScore, teamBScore, mapName: mapName || null }
    });
  });

  await applySimpleMatchElo(match.id, winnerTeam);

  const players = await query(`SELECT user_id, party_id FROM match_players WHERE match_id = $1`, [match.id]);
  const touchedPartyIds = new Set();
  for (const row of players.rows) if (row.party_id) touchedPartyIds.add(row.party_id);

  for (const row of players.rows) {
    const nextPartyId = row.party_id || null;
    const nextState = nextPartyId ? 'in_party' : 'online';
    await setPresence(row.user_id, nextState, nextPartyId, null);
  }

  for (const partyId of touchedPartyIds) {
    await query(`UPDATE parties SET status = 'open', updated_at = NOW() WHERE id = $1`, [partyId]);
    await query(`UPDATE queue_entries SET status = 'cancelled' WHERE party_id = $1 AND status <> 'cancelled'`, [partyId]);
  }

  return { alreadyFinished: false };
}

async function getPendingPostMatchSummary(userId) {
  const result = await query(
    `SELECT m.id, m.public_match_id, m.mode, m.map_name, m.team_a_score, m.team_b_score, m.winner_team,
            m.finished_at, m.finish_reason, mp.team, mp.result, mp.elo_before, mp.elo_after, mp.elo_delta, mp.result_seen_at
     FROM match_players mp
     JOIN matches m ON m.id = mp.match_id
     WHERE mp.user_id = $1
       AND m.status = 'finished'
       AND (m.result_ack_required = TRUE OR mp.result_seen_at IS NULL)
     ORDER BY m.finished_at DESC NULLS LAST, m.created_at DESC
     LIMIT 1`,
    [userId]
  );
  const row = result.rows[0] || null;
  if (!row) return null;
  return {
    publicMatchId: row.public_match_id,
    mode: row.mode,
    mapName: row.map_name,
    team: row.team,
    result: row.result,
    winnerTeam: row.winner_team,
    teamAScore: Number(row.team_a_score || 0),
    teamBScore: Number(row.team_b_score || 0),
    eloBefore: row.elo_before == null ? null : Number(row.elo_before),
    eloAfter: row.elo_after == null ? null : Number(row.elo_after),
    eloDelta: row.elo_delta == null ? null : Number(row.elo_delta),
    finishReason: normalizeFinishReason(row.finish_reason),
    finishedAt: row.finished_at
  };
}

async function acknowledgePostMatchSummary(userId, publicMatchId) {
  return withTransaction(async (client) => {
    const rowRes = await client.query(
      `SELECT mp.id, m.id AS match_id
       FROM match_players mp
       JOIN matches m ON m.id = mp.match_id
       WHERE mp.user_id = $1 AND m.public_match_id = $2 AND m.status = 'finished'
       LIMIT 1
       FOR UPDATE`,
      [userId, publicMatchId]
    );
    const row = rowRes.rows[0];
    if (!row) throw new Error('match_not_found');

    await client.query(`UPDATE match_players SET result_seen_at = NOW() WHERE id = $1`, [row.id]);
    const pendingRes = await client.query(`SELECT COUNT(*)::int AS pending FROM match_players WHERE match_id = $1 AND result_seen_at IS NULL`, [row.match_id]);
    if (Number(pendingRes.rows[0]?.pending || 0) === 0) {
      await client.query(`UPDATE matches SET result_ack_required = FALSE WHERE id = $1`, [row.match_id]);
    }
    return true;
  });
}

module.exports = {
  MAP_POOL,
  ISSUE_REASONS,
  FINISH_REASONS,
  getCurrentMatchByUserId,
  getMatchRoomByPublicId,
  getMatchHistory,
  acceptCurrentMatch,
  submitMapVote,
  submitMatchIssue,
  submitMatchResult,
  getPendingPostMatchSummary,
  acknowledgePostMatchSummary,
  normalizeFinishReason,
  finishReasonLabel
};
