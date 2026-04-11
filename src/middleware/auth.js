const { verifyAuthToken } = require('../utils/authToken');

function getBearerToken(req) {
  const header = req.headers?.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function getAuthenticatedUserId(req) {
  if (req.session?.userId) return Number(req.session.userId);

  const token = getBearerToken(req);
  const payload = verifyAuthToken(token);
  if (payload?.userId) {
    if (req.session) req.session.userId = payload.userId;
    return payload.userId;
  }

  return null;
}

function requireAuth(req, res, next) {
  const userId = getAuthenticatedUserId(req);
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  req.authUserId = userId;
  next();
}

module.exports = { requireAuth, getAuthenticatedUserId };
