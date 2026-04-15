const { query, withTransaction } = require('../db');
const config = require('../config');

const PENALTY_TYPES = {
  accept_timeout: {
    category: 'cooldown',
    durationSeconds: config.acceptTimeoutPenaltySeconds,
    title: 'Матч не был принят вовремя',
    message: 'Вы не приняли матч вовремя. Поиск временно заблокирован.'
  },
  no_connect: {
    category: 'cooldown',
    durationSeconds: config.noConnectPenaltySeconds,
    title: 'Подтверждённый матч пропущен',
    message: 'Вы приняли матч, но не подключились к серверу вовремя.'
  },
  abandon: {
    category: 'abandon',
    durationSeconds: config.abandonPenaltySeconds,
    title: 'Засчитан abandon',
    message: 'Вы покинули live-матч и не вернулись в grace period.'
  }
};

function msRemaining(lockedUntil) {
  if (!lockedUntil) return 0;
  return Math.max(0, new Date(lockedUntil).getTime() - Date.now());
}

function formatRestriction(row) {
  if (!row) return null;
  const remainingMs = msRemaining(row.locked_until);
  if (remainingMs <= 0) return null;
  return {
    isActive: true,
    type: row.penalty_type,
    category: row.lock_category,
    reasonKey: row.reason_key,
    source: row.source,
    title: row.reason_title,
    message: row.reason_message,
    lockedUntil: row.locked_until,
    remainingMs,
    remainingSec: Math.ceil(remainingMs / 1000),
    remainingText: humanizeDuration(remainingMs)
  };
}

function humanizeDuration(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) return `${hours}ч ${minutes}м`;
  if (minutes > 0) return `${minutes}м ${seconds}с`;
  return `${seconds}с`;
}

async function getActiveRestriction(userId) {
  const result = await query(
    `SELECT *
     FROM player_restrictions
     WHERE user_id = $1 AND locked_until > NOW()
     ORDER BY locked_until DESC
     LIMIT 1`,
    [userId]
  );
  return formatRestriction(result.rows[0] || null);
}

async function getRestrictionState(userId) {
  const [restrictionResult, currentMatchResult, queueResult] = await Promise.all([
    query(
      `SELECT *
       FROM player_restrictions
       WHERE user_id = $1 AND locked_until > NOW()
       ORDER BY locked_until DESC
       LIMIT 1`,
      [userId]
    ),
    query(
      `SELECT m.public_match_id, m.status
       FROM match_players mp
       JOIN matches m ON m.id = mp.match_id
       WHERE mp.user_id = $1
         AND (
           m.status = 'map_voting'
           OR m.status = 'live'
           OR (m.status = 'pending_acceptance' AND (m.accept_expires_at IS NULL OR m.accept_expires_at > NOW()))
           OR (m.status = 'server_assigned' AND (m.connect_expires_at IS NULL OR m.connect_expires_at > NOW()))
         )
       ORDER BY m.created_at DESC
       LIMIT 1`,
      [userId]
    ),
    query(
      `SELECT qe.id, qe.status, qe.mode
       FROM party_members pm
       JOIN queue_entries qe ON qe.party_id = pm.party_id AND qe.status = 'queued'
       WHERE pm.user_id = $1
       LIMIT 1`,
      [userId]
    )
  ]);

  const restriction = formatRestriction(restrictionResult.rows[0] || null);
  const activeMatch = currentMatchResult.rows[0] || null;
  const activeQueue = queueResult.rows[0] || null;

  let canQueue = true;
  let block = restriction;

  if (restriction?.isActive) {
    canQueue = false;
  } else if (activeMatch) {
    canQueue = false;
    block = {
      isActive: true,
      type: activeMatch.status === 'live' ? 'live_match_lock' : 'match_lock',
      category: 'queue_lock',
      reasonKey: activeMatch.status === 'live' ? 'already_in_live_match' : 'already_in_match_flow',
      source: 'system',
      title: activeMatch.status === 'live' ? 'Идёт live-матч' : 'У вас уже есть активный матч',
      message: activeMatch.status === 'live'
        ? 'Нельзя снова искать матч, пока текущая игра не завершена.'
        : 'Нельзя снова искать матч, пока не завершён этап accept / map vote / connect.',
      lockedUntil: null,
      remainingMs: 0,
      remainingSec: 0,
      remainingText: activeMatch.status === 'live' ? 'до конца матча' : 'до завершения текущего матча',
      matchId: activeMatch.public_match_id,
      matchStatus: activeMatch.status
    };
  } else if (activeQueue) {
    canQueue = false;
    block = {
      isActive: true,
      type: 'queue_lock',
      category: 'queue_lock',
      reasonKey: 'already_in_queue',
      source: 'system',
      title: 'Поиск уже запущен',
      message: 'Вы уже находитесь в очереди 2x2.',
      remainingMs: 0,
      remainingSec: 0,
      remainingText: 'до отмены поиска'
    };
  }

  return {
    canQueue,
    restriction: block,
    activeMatch: activeMatch ? {
      publicMatchId: activeMatch.public_match_id,
      status: activeMatch.status
    } : null,
    activeQueue: activeQueue ? {
      mode: activeQueue.mode,
      status: activeQueue.status
    } : null
  };
}

async function assertCanQueue(userId) {
  const state = await getRestrictionState(userId);
  if (!state.canQueue) {
    const code = state.restriction?.reasonKey || state.restriction?.type || 'queue_locked';
    const error = new Error(code);
    error.code = code;
    error.details = state;
    throw error;
  }
  return state;
}

async function applyPenalty(client, { userId, penaltyType, reasonKey, source = 'system', matchId = null, matchPlayerId = null, metadata = null }) {
  const def = PENALTY_TYPES[penaltyType];
  if (!def) throw new Error(`unknown_penalty_type:${penaltyType}`);
  const result = await client.query(
    `INSERT INTO player_restriction_events (
       user_id, penalty_type, lock_category, reason_key, reason_title, reason_message,
       source, duration_seconds, locked_until, match_id, match_player_id, metadata, created_at
     )
     VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, NOW() + ($8 * INTERVAL '1 second'), $9, $10, $11::jsonb, NOW()
     )
     RETURNING id, locked_until`,
    [
      userId,
      penaltyType,
      def.category,
      reasonKey || penaltyType,
      def.title,
      def.message,
      source,
      def.durationSeconds,
      matchId,
      matchPlayerId,
      metadata ? JSON.stringify(metadata) : null
    ]
  );

  await client.query(
    `INSERT INTO player_restrictions (
       user_id, penalty_type, lock_category, reason_key, reason_title, reason_message,
       source, locked_until, active_match_id, active_match_player_id, metadata, updated_at, created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, NOW(), NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET
       penalty_type = EXCLUDED.penalty_type,
       lock_category = EXCLUDED.lock_category,
       reason_key = EXCLUDED.reason_key,
       reason_title = EXCLUDED.reason_title,
       reason_message = EXCLUDED.reason_message,
       source = EXCLUDED.source,
       locked_until = GREATEST(player_restrictions.locked_until, EXCLUDED.locked_until),
       active_match_id = EXCLUDED.active_match_id,
       active_match_player_id = EXCLUDED.active_match_player_id,
       metadata = EXCLUDED.metadata,
       updated_at = NOW()`,
    [
      userId,
      penaltyType,
      def.category,
      reasonKey || penaltyType,
      def.title,
      def.message,
      source,
      result.rows[0].locked_until,
      matchId,
      matchPlayerId,
      metadata ? JSON.stringify(metadata) : null
    ]
  );

  return result.rows[0];
}

module.exports = {
  PENALTY_TYPES,
  humanizeDuration,
  getActiveRestriction,
  getRestrictionState,
  assertCanQueue,
  applyPenalty
};
