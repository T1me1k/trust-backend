const express = require('express');
const { ok, fail } = require('../utils/http');
const { submitMatchResult } = require('../services/matchService');

const router = express.Router();

router.post('/server/result', async (req, res) => {
  try {
    const { matchId, winnerTeam, teamAScore, teamBScore, map } = req.body || {};
    if (!matchId || !winnerTeam) return fail(res, 400, 'missing_fields');
    const result = await submitMatchResult({
      publicMatchId: matchId,
      winnerTeam,
      teamAScore: Number(teamAScore || 0),
      teamBScore: Number(teamBScore || 0),
      mapName: map || null,
      resultSource: 'server_plugin'
    });
    return ok(res, result);
  } catch (err) {
    return fail(res, 400, err.message || 'result_submit_failed');
  }
});

module.exports = router;
