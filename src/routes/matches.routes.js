const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { ok, fail } = require('../utils/http');
const {
  getCurrentMatchByUserId,
  getMatchHistory,
  acceptCurrentMatch,
  submitMapVote,
  MAP_POOL
} = require('../services/matchService');
const { getMatchDetailsForUser } = require('../services/profileService');

const router = express.Router();
router.use(requireAuth);

router.get('/me/current', async (req, res) => {
  const match = await getCurrentMatchByUserId(req.session.userId);
  return ok(res, { match, mapPool: MAP_POOL });
});

router.get('/me/history', async (req, res) => {
  const items = await getMatchHistory(req.session.userId, Number(req.query.limit || 8));
  return ok(res, { items });
});


router.get('/:publicMatchId/details', async (req, res) => {
  const match = await getMatchDetailsForUser({
    publicMatchId: req.params.publicMatchId,
    viewerUserId: req.session.userId
  });
  if (!match) return fail(res, 404, 'match_not_found');
  return ok(res, { match });
});

router.post('/:publicMatchId/accept', async (req, res) => {
  try {
    const result = await acceptCurrentMatch(req.session.userId, req.params.publicMatchId);
    return ok(res, result);
  } catch (err) {
    return fail(res, 400, err.message || 'match_accept_failed');
  }
});

router.post('/:publicMatchId/map-vote', async (req, res) => {
  try {
    const result = await submitMapVote(req.session.userId, req.params.publicMatchId, String(req.body.mapName || ''));
    return ok(res, result);
  } catch (err) {
    return fail(res, 400, err.message || 'map_vote_failed');
  }
});

module.exports = router;
