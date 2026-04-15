const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { ok, fail } = require('../utils/http');
const { getQueueState, getQueueOverview, joinQueue, cancelQueue } = require('../services/queueService');

const router = express.Router();
router.use(requireAuth);

router.get('/me', async (req, res) => {
  const overview = await getQueueOverview(req.authUserId);
  return ok(res, overview);
});

router.get('/restrictions', async (req, res) => {
  const overview = await getQueueOverview(req.authUserId);
  return ok(res, { restrictions: overview.restrictions });
});

router.post('/join', async (req, res) => {
  try {
    const queue = await joinQueue(req.authUserId, req.body.mode || '2x2');
    return ok(res, { queue });
  } catch (err) {
    return fail(res, 400, err.message || 'queue_join_failed');
  }
});

router.post('/cancel', async (req, res) => {
  try {
    await cancelQueue(req.authUserId);
    return ok(res, { cancelled: true });
  } catch (err) {
    return fail(res, 400, err.message || 'queue_cancel_failed');
  }
});

module.exports = router;
