const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { ok } = require('../utils/http');
const { getCurrentMatchByUserId, getMatchHistory } = require('../services/matchService');

const router = express.Router();
router.use(requireAuth);

router.get('/me/current', async (req, res) => {
  const match = await getCurrentMatchByUserId(req.authUserId || req.session.userId);
  return ok(res, { match });
});

router.get('/me/history', async (req, res) => {
  const items = await getMatchHistory(req.authUserId || req.session.userId, Number(req.query.limit || 8));
  return ok(res, { items });
});

module.exports = router;
