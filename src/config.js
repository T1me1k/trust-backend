const parseBool = (v, d = false) => {
  if (v === undefined || v === null || v === '') return d;
  return String(v).toLowerCase() === 'true';
};

function toOrigin(value) {
  if (!value) return '';
  try {
    return new URL(value).origin;
  } catch (_) {
    return String(value).replace(/\/+$/, '');
  }
}

module.exports = {
  port: Number(process.env.PORT || 3000),
  backendBaseUrl: process.env.BACKEND_BASE_URL || '',
  publicSiteUrl: process.env.PUBLIC_SITE_URL || '',
  siteOrigin: process.env.SITE_ORIGIN || process.env.PUBLIC_SITE_URL || '',
  sessionSecret: process.env.SESSION_SECRET || 'change_me',
  steamApiKey: process.env.STEAM_API_KEY || '',
  cookieSecure: parseBool(process.env.COOKIE_SECURE, true),
  defaultRegion: process.env.DEFAULT_REGION || 'EU',
  defaultMatchMode: process.env.DEFAULT_MATCH_MODE || '2x2',
  defaultServerIp: process.env.DEFAULT_SERVER_IP || '127.0.0.1',
  defaultServerPort: Number(process.env.DEFAULT_SERVER_PORT || 27015),
  defaultServerPassword: process.env.DEFAULT_SERVER_PASSWORD || 'trust',
  matchmakingIntervalMs: Number(process.env.MATCHMAKING_INTERVAL_MS || 3000),
  allowedOrigins: Array.from(new Set([
    process.env.SITE_ORIGIN || process.env.PUBLIC_SITE_URL || '',
    process.env.PUBLIC_SITE_URL || ''
  ].map(toOrigin).filter(Boolean)))
};
