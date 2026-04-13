const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { ok, fail } = require('../utils/http');
const { getQueueState, joinQueue, cancelQueue } = require('../services/queueService');

const router = express.Router();
router.use(requireAuth);

router.get('/me', async (req, res) => {
  const state = await getQueueState(req.session.userId);
  return ok(res, state);
});

router.post('/join', async (req, res) => {
  try {
    const state = await joinQueue(req.session.userId, req.body.mode || '2x2');
    return ok(res, state);
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

module.exports = router;
