function createRateLimiter({ windowMs = 60_000, max = 60, keyPrefix = 'rl', skip = null } = {}) {
  const buckets = new Map();

  function getClientKey(req) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return `${keyPrefix}:${forwarded || req.ip || req.socket?.remoteAddress || 'unknown'}`;
  }

  return function rateLimiter(req, res, next) {
    if (typeof skip === 'function' && skip(req)) return next();

    const now = Date.now();
    const key = getClientKey(req);
    const existing = buckets.get(key);
    const bucket = existing && existing.resetAt > now
      ? existing
      : { count: 0, resetAt: now + windowMs };

    bucket.count += 1;
    buckets.set(key, bucket);

    if (bucket.count > max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ ok: false, error: 'rate_limited', retryAfterSeconds });
    }

    if (buckets.size > 5000) {
      for (const [bucketKey, value] of buckets.entries()) {
        if (value.resetAt <= now) buckets.delete(bucketKey);
      }
    }

    return next();
  };
}

module.exports = { createRateLimiter };
