const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { ok, fail } = require('../utils/http');
const { createLauncherLinkCode, consumeLauncherLinkCode } = require('../services/launcherLinkService');

const router = express.Router();

router.post('/link/start', async (req, res) => {
  try {
    const { clientId, nickname } = req.body || {};
    if (!clientId) return fail(res, 400, 'missing_client_id');
    const code = await createLauncherLinkCode({ clientId, nickname });
    return ok(res, { link: code });
  } catch (err) {
    return fail(res, 400, err.message || 'link_start_failed');
  }
});

router.post('/link/consume', requireAuth, async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return fail(res, 400, 'missing_code');
    const link = await consumeLauncherLinkCode({ code, userId: req.session.userId });
    return ok(res, { link });
  } catch (err) {
    return fail(res, 400, err.message || 'link_consume_failed');
  }
});

module.exports = router;
