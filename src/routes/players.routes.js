const express = require('express');
const { ok } = require('../utils/http');
const { getPlayerMatchHistoryBySteamId, getPlayerAggregatedStatsBySteamId } = require('../services/profileService');

const router = express.Router();

router.get('/:steamId/matches', async (req, res) => {
  const result = await getPlayerMatchHistoryBySteamId(req.params.steamId, req.query.page, req.query.limit);
  return ok(res, result);
});

router.get('/:steamId/stats', async (req, res) => {
  const stats = await getPlayerAggregatedStatsBySteamId(req.params.steamId);
  return ok(res, { stats });
});

module.exports = router;
