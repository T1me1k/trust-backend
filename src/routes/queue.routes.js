const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { ok, fail } = require('../utils/http');
const { getQueueState, getQueueOverview, getPublicQueueStats, getQueueDebugSnapshot, joinQueue, cancelQueue, runMatchmakingCycle, maybeRunMatchmakingFallback } = require('../services/queueService');

const router = express.Router();

router.get('/stats', async (_req, res) => {
  const stats = await getPublicQueueStats();
  const fallback = (stats.searchingPlayers >= 4 && stats.activeMatches === 0)
    ? await maybeRunMatchmakingFallback().catch((error) => ({ triggered: false, reason: error.message || 'fallback_failed' }))
    : null;
  const refreshedStats = fallback?.triggered ? await getPublicQueueStats() : stats;
  return ok(res, { stats: refreshedStats, fallback });
});

router.use(requireAuth);

router.get('/me', async (req, res) => {
  const overview = await getQueueOverview(req.session.userId);
  return ok(res, overview);
});

router.get('/restrictions', async (req, res) => {
  const overview = await getQueueOverview(req.session.userId);
  return ok(res, { restrictions: overview.restrictions });
});


router.post('/join', async (req, res) => {
  try {
    const queue = await joinQueue(req.session.userId, req.body.mode || '2x2');
    const matchmaking = await runMatchmakingCycle().catch((error) => ({ error: error.message || 'matchmaking_failed' }));
    return ok(res, { queue, matchmaking: matchmaking ? { publicMatchId: matchmaking.public_match_id || null } : null });
  } catch (err) {
    return fail(res, 400, err.message || 'queue_join_failed');
  }
});

router.post('/cancel', async (req, res) => {
  try {
    await cancelQueue(req.session.userId);
    return ok(res, { cancelled: true });
  } catch (err) {
    return fail(res, 400, err.message || 'queue_cancel_failed');
  }
});

router.get('/debug/snapshot', async (_req, res) => {
  const snapshot = await getQueueDebugSnapshot();
  return ok(res, { snapshot });
});

module.exports = router;
