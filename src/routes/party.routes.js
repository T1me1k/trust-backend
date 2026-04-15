const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { ok, fail } = require('../utils/http');
const {
  getCurrentPartyByUserId,
  createParty,
  inviteToParty,
  acceptInvite,
  declineInvite,
  leaveParty,
  disbandParty
} = require('../services/partyService');
const { setPresence } = require('../services/accountService');

const router = express.Router();
router.use(requireAuth);

router.post('/create', async (req, res) => {
  const party = await createParty(req.authUserId);
  return ok(res, { party });
});

router.get('/me', async (req, res) => {
  const party = await getCurrentPartyByUserId(req.authUserId);
  return ok(res, { party });
});

router.post('/invite', async (req, res) => {
  try {
    const targetUserId = req.body.targetUserId;
    if (!targetUserId) return fail(res, 400, 'missing_target_user_id');
    const invite = await inviteToParty({ actorUserId: req.authUserId, targetUserId });
    return ok(res, { invite });
  } catch (err) {
    return fail(res, 400, err.message || 'party_invite_failed');
  }
});

router.post('/invite/:id/accept', async (req, res) => {
  try {
    const result = await acceptInvite(req.params.id, req.authUserId);
    await setPresence(req.authUserId, 'in_party', result.partyId, null);
    return ok(res, { accepted: true, replacedLobby: (result.replacedMemberIds || []).length > 0 });
  } catch (err) {
    return fail(res, 400, err.message || 'accept_failed');
  }
});

router.post('/invite/:id/decline', async (req, res) => {
  const changed = await declineInvite(req.params.id, req.authUserId);
  if (!changed) return fail(res, 404, 'invite_not_found');
  return ok(res, { declined: true });
});

router.post('/leave', async (req, res) => {
  try {
    await leaveParty(req.authUserId);
    return ok(res, { left: true });
  } catch (err) {
    return fail(res, 400, err.message || 'leave_failed');
  }
});

router.post('/disband', async (req, res) => {
  try {
    await disbandParty(req.authUserId);
    return ok(res, { disbanded: true });
  } catch (err) {
    return fail(res, 400, err.message || 'disband_failed');
  }
});

module.exports = router;
