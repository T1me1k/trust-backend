const { verifyAuthToken } = require('../utils/authToken');

function getBearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization;
  if (!header || typeof header !== 'string') return '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function resolveAuthUserId(req) {
  const sessionUserId = Number(req.session?.userId || 0);
  if (sessionUserId > 0) return sessionUserId;

  const token = getBearerToken(req);
  const payload = verifyAuthToken(token);
  const tokenUserId = Number(payload?.userId || 0);
  if (tokenUserId > 0) {
    req.authToken = token;
    req.authTokenPayload = payload;
    if (req.session) req.session.userId = tokenUserId;
    return tokenUserId;
  }
  return 0;
}

function requireAuth(req, res, next) {
  const userId = resolveAuthUserId(req);
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  req.authUserId = userId;
  next();
}

module.exports = { requireAuth, resolveAuthUserId, getBearerToken };
