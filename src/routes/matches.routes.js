const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { ok, fail } = require('../utils/http');
const {
  getCurrentMatchByUserId,
  getMatchHistory,
  getMatchRoomByPublicId,
  acceptCurrentMatch,
  submitMapVote,
  submitMatchIssue,
  getPendingPostMatchSummary,
  acknowledgePostMatchSummary,
  MAP_POOL,
  ISSUE_REASONS,
  FINISH_REASONS
} = require('../services/matchService');
const { getMatchDetailsForUser } = require('../services/profileService');

const router = express.Router();
router.use(requireAuth);

router.get('/me/current', async (req, res) => {
  const match = await getCurrentMatchByUserId(req.authUserId);
  return ok(res, { match, mapPool: MAP_POOL, issueReasons: ISSUE_REASONS, finishReasons: FINISH_REASONS });
});

router.get('/me/history', async (req, res) => {
  const items = await getMatchHistory(req.authUserId, Number(req.query.limit || 8));
  return ok(res, { items });
});

router.get('/me/post-match', async (req, res) => {
  const summary = await getPendingPostMatchSummary(req.authUserId);
  return ok(res, { summary });
});

router.get('/:publicMatchId/room', async (req, res) => {
  const room = await getMatchRoomByPublicId(req.authUserId, req.params.publicMatchId);
  if (!room) return fail(res, 404, 'match_room_not_found');
  return ok(res, { room, mapPool: MAP_POOL, issueReasons: ISSUE_REASONS, finishReasons: FINISH_REASONS });
});

router.get('/:publicMatchId/details', async (req, res) => {
  const match = await getMatchDetailsForUser({
    publicMatchId: req.params.publicMatchId,
    viewerUserId: req.authUserId
  });
  if (!match) return fail(res, 404, 'match_not_found');
  return ok(res, { match });
});

router.post('/:publicMatchId/accept', async (req, res) => {
  try {
    const result = await acceptCurrentMatch(req.authUserId, req.params.publicMatchId);
    return ok(res, result);
  } catch (err) {
    return fail(res, 400, err.message || 'match_accept_failed');
  }
});

router.post('/:publicMatchId/map-vote', async (req, res) => {
  try {
    const result = await submitMapVote(req.authUserId, req.params.publicMatchId, String(req.body.mapName || ''));
    return ok(res, result);
  } catch (err) {
    return fail(res, 400, err.message || 'map_vote_failed');
  }
});

router.post('/:publicMatchId/issues', async (req, res) => {
  try {
    const result = await submitMatchIssue({
      userId: req.authUserId,
      publicMatchId: req.params.publicMatchId,
      phase: String(req.body.phase || ''),
      reason: String(req.body.reason || ''),
      comment: String(req.body.comment || '')
    });
    return ok(res, result);
  } catch (err) {
    return fail(res, 400, err.message || 'match_issue_failed');
  }
});

router.post('/:publicMatchId/post-match/ack', async (req, res) => {
  try {
    await acknowledgePostMatchSummary(req.authUserId, req.params.publicMatchId);
    return ok(res, { acknowledged: true });
  } catch (err) {
    return fail(res, 400, err.message || 'post_match_ack_failed');
  }
});

module.exports = router;
