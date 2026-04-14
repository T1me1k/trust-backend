const FINISH_REASONS = [
  'finished',
  'cancelled_accept_timeout',
  'cancelled_connect_timeout',
  'abandoned',
  'technical_cancel',
  'result_pending'
];

function normalizeFinishReason(input, fallback = 'finished') {
  const value = String(input || '').trim().toLowerCase();
  if (FINISH_REASONS.includes(value)) return value;
  if (value === 'accept_timeout' || value === 'cancelled' || value === 'timeout_accept') return 'cancelled_accept_timeout';
  if (value === 'connect_timeout' || value === 'timeout_connect' || value === 'no_connect') return 'cancelled_connect_timeout';
  if (value === 'abandon' || value === 'abandon_registered') return 'abandoned';
  if (value === 'pending' || value === 'awaiting_result') return 'result_pending';
  return fallback;
}

function finishReasonLabel(reason) {
  switch (normalizeFinishReason(reason)) {
    case 'finished': return 'Матч завершён';
    case 'cancelled_accept_timeout': return 'Матч отменён: accept timeout';
    case 'cancelled_connect_timeout': return 'Матч отменён: connect timeout';
    case 'abandoned': return 'Матч завершён по abandon';
    case 'technical_cancel': return 'Матч отменён по технической причине';
    case 'result_pending': return 'Результат ожидает подтверждения';
    default: return 'Матч завершён';
  }
}

async function logMatchEvent(client, payload) {
  const {
    matchId,
    eventType,
    phase = null,
    actorUserId = null,
    actorSteamId = null,
    title,
    description = null,
    metadata = null
  } = payload || {};

  if (!client || !matchId || !eventType || !title) return;

  await client.query(
    `INSERT INTO match_events (
       match_id, event_type, phase, actor_user_id, actor_steam_id, title, description, metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [matchId, eventType, phase, actorUserId, actorSteamId, title, description, metadata ? JSON.stringify(metadata) : null]
  );
}

module.exports = {
  FINISH_REASONS,
  normalizeFinishReason,
  finishReasonLabel,
  logMatchEvent
};
