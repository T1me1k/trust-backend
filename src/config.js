const parseBool = (v, d = false) => {
  if (v === undefined || v === null || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

function toOrigin(value) {
  if (!value) return '';
  try {
    return new URL(value).origin;
  } catch (_) {
    return String(value).replace(/\/+$/, '');
  }
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const publicSiteUrl = process.env.PUBLIC_SITE_URL || '';
const siteOrigin = process.env.SITE_ORIGIN || publicSiteUrl || '';
const extraAllowedOrigins = splitCsv(process.env.ALLOWED_ORIGINS);

module.exports = {
  port: Number(process.env.PORT || 3000),
  backendBaseUrl: process.env.BACKEND_BASE_URL || '',
  publicSiteUrl,
  siteOrigin,
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
    siteOrigin,
    publicSiteUrl,
    process.env.BACKEND_BASE_URL || '',
    ...extraAllowedOrigins,
    'http://127.0.0.1:5500',
    'http://localhost:5500',
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    'http://127.0.0.1:3000',
    'http://localhost:3000'
  ].map(toOrigin).filter(Boolean)))
};
