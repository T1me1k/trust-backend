const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { ok, fail } = require('../utils/http');
const {
  getProfileSummaryByUserId,
  getProfileHistoryByUserId
} = require('../services/profileService');

const router = express.Router();
router.use(requireAuth);

router.get('/me', async (req, res) => {
  const profile = await getProfileSummaryByUserId(req.session.userId);
  return ok(res, { profile });
});

router.get('/me/history', async (req, res) => {
  const items = await getProfileHistoryByUserId(req.session.userId, req.query.limit);
  return ok(res, { items });
});

router.get('/:userId', async (req, res) => {
  const profile = await getProfileSummaryByUserId(req.params.userId);
  if (!profile) return fail(res, 404, 'profile_not_found');
  return ok(res, { profile });
});

router.get('/:userId/history', async (req, res) => {
  const profile = await getProfileSummaryByUserId(req.params.userId);
  if (!profile) return fail(res, 404, 'profile_not_found');
  const items = await getProfileHistoryByUserId(req.params.userId, req.query.limit);
  return ok(res, { items });
});

module.exports = router;
