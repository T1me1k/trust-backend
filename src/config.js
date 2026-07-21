const parseBool = (v, d = false) => {
  if (v === undefined || v === null || v === '') return d;
  return String(v).toLowerCase() === 'true';
};

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parsePort = (value, fallback) => {
  const parsed = parsePositiveInt(value, fallback);
  return parsed >= 1 && parsed <= 65535 ? parsed : fallback;
};

function toOrigin(value) {
  if (!value) return '';
  try {
    return new URL(value).origin;
  } catch (_) {
    return String(value).replace(/\/+$/, '');
  }
}

function splitOrigins(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map(toOrigin)
    .filter(Boolean);
}

const allowedOrigins = Array.from(new Set([
  ...splitOrigins(process.env.ALLOWED_ORIGINS),
  toOrigin(process.env.SITE_ORIGIN || ''),
  toOrigin(process.env.PUBLIC_SITE_URL || ''),
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173'
].filter(Boolean)));

module.exports = {
  port: parsePort(process.env.PORT, 3000),
  backendBaseUrl: process.env.BACKEND_BASE_URL || '',
  publicSiteUrl: process.env.PUBLIC_SITE_URL || '',
  siteOrigin: process.env.SITE_ORIGIN || process.env.PUBLIC_SITE_URL || '',
  sessionSecret: process.env.SESSION_SECRET || 'change_me',
  authTokenTtlDays: parsePositiveInt(process.env.AUTH_TOKEN_TTL_DAYS, 30),
  trustProductionMode: parseBool(process.env.TRUST_PRODUCTION_MODE, process.env.NODE_ENV === 'production'),
  steamApiKey: process.env.STEAM_API_KEY || '',
  cookieSecure: parseBool(process.env.COOKIE_SECURE, true),
  defaultRegion: process.env.DEFAULT_REGION || 'EU',
  defaultMatchMode: process.env.DEFAULT_MATCH_MODE || '2x2',
  defaultServerIp: process.env.DEFAULT_SERVER_IP || '127.0.0.1',
  defaultServerPort: parsePort(process.env.DEFAULT_SERVER_PORT, 27015),
  defaultServerPassword: process.env.DEFAULT_SERVER_PASSWORD || 'trust',
  defaultServerToken: process.env.DEFAULT_SERVER_TOKEN || 'local-dev-token',
  matchmakingIntervalMs: parsePositiveInt(process.env.MATCHMAKING_INTERVAL_MS, 3000),
  acceptTimeoutSeconds: parsePositiveInt(process.env.ACCEPT_TIMEOUT_SECONDS, 20),
  mapVoteTimeoutSeconds: parsePositiveInt(process.env.MAP_VOTE_TIMEOUT_SECONDS, 35),
  connectTimeoutSeconds: parsePositiveInt(process.env.CONNECT_TIMEOUT_SECONDS, 75),
  reconnectGraceSeconds: parsePositiveInt(process.env.RECONNECT_GRACE_SECONDS, 90),
  acceptTimeoutPenaltySeconds: parsePositiveInt(process.env.ACCEPT_TIMEOUT_PENALTY_SECONDS, 300),
  noConnectPenaltySeconds: parsePositiveInt(process.env.NO_CONNECT_PENALTY_SECONDS, 600),
  abandonPenaltySeconds: parsePositiveInt(process.env.ABANDON_PENALTY_SECONDS, 1800),
  allowedOrigins
};
