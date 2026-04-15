const { verifyAuthToken } = require('../utils/authToken');

function getBearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization;
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function resolveAuthUserId(req) {
  if (req.authUserId) return req.authUserId;

  if (req.session?.userId) {
    req.authUserId = Number(req.session.userId);
    return req.authUserId;
  }

  const token = getBearerToken(req);
  const payload = verifyAuthToken(token);
  if (!payload?.userId) return null;

  req.authUserId = Number(payload.userId);
  if (req.session && !req.session.userId) req.session.userId = req.authUserId;
  return req.authUserId;
}

function requireAuth(req, res, next) {
  const userId = resolveAuthUserId(req);
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

module.exports = { requireAuth, resolveAuthUserId };
