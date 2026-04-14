const http = require('http');
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const pgSession = require('connect-pg-simple')(session);

const config = require('../src/config');
const { pool } = require('../src/db');
const { initSchema } = require('../src/db/initSchema');
const { runMatchmakingCycle } = require('../src/services/queueService');

const authRoutes = require('../src/routes/auth.routes');
const accountRoutes = require('../src/routes/account.routes');
const partyRoutes = require('../src/routes/party.routes');
const queueRoutes = require('../src/routes/queue.routes');
const matchesRoutes = require('../src/routes/matches.routes');
const launcherRoutes = require('../src/routes/launcher.routes');
const leaderboardRoutes = require('../src/routes/leaderboard.routes');
const profileRoutes = require('../src/routes/profile.routes');
const internalRoutes = require('./routes/internal.routes');

const PORT = Number(process.env.PORT || config.port || 3000);
const HOST = '0.0.0.0';
const MATCHMAKING_INTERVAL_MS = Number(process.env.MATCHMAKING_INTERVAL_MS || config.matchmakingIntervalMs || 3000);

const app = express();
const server = http.createServer(app);
let matchmakingTimer = null;
let matchmakingRunning = false;
let shuttingDown = false;

function getAllowedOrigins() {
  const raw = config.allowedOrigins || process.env.ALLOWED_ORIGINS || '';
  return String(raw).split(',').map((v) => v.trim()).filter(Boolean);
}

function setupCoreMiddleware() {
  const allowedOrigins = getAllowedOrigins();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser());
  app.use(session({
    store: new pgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
    name: 'trust.sid',
    secret: process.env.SESSION_SECRET || config.sessionSecret || 'change-me',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      maxAge: 1000 * 60 * 60 * 24 * 30
    }
  }));
}

function setupRoutes() {
  app.get('/health', (_req, res) => res.status(200).json({ ok: true, service: 'trust-backend', uptimeSec: Math.floor(process.uptime()), timestamp: new Date().toISOString() }));
  app.get('/config', (_req, res) => res.status(200).json({ ok: true, config: { appName: 'TRUST', latestVersion: '2.0.2', mode: process.env.DEFAULT_MATCH_MODE || config.defaultMatchMode || '2x2', region: process.env.DEFAULT_REGION || config.defaultRegion || 'EU', matchmakingEnabled: true } }));

  app.use('/auth', authRoutes); app.use('/api/auth', authRoutes);
  app.use('/account', accountRoutes); app.use('/api/account', accountRoutes);
  app.use('/party', partyRoutes); app.use('/api/party', partyRoutes);
  app.use('/queue', queueRoutes); app.use('/api/queue', queueRoutes);
  app.use('/matches', matchesRoutes); app.use('/api/matches', matchesRoutes);
  app.use('/launcher', launcherRoutes); app.use('/api/launcher', launcherRoutes);
  app.use('/leaderboard', leaderboardRoutes); app.use('/api/leaderboard', leaderboardRoutes);
  app.use('/profile', profileRoutes); app.use('/api/profile', profileRoutes);
  app.use('/internal', internalRoutes);

  app.use((req, res) => res.status(404).json({ ok: false, error: 'not_found', path: req.originalUrl }));
  app.use((err, _req, res, _next) => {
    console.error('[http] unhandled error:', err);
    res.status(err?.statusCode || 500).json({ ok: false, error: err?.message || 'internal_error' });
  });
}

async function runMatchmakingTick() {
  if (matchmakingRunning || shuttingDown) return;
  matchmakingRunning = true;
  try { await runMatchmakingCycle(); } catch (e) { console.error('matchmaking cycle error:', e); } finally { matchmakingRunning = false; }
}

function startMatchmakingLoop() {
  if (matchmakingTimer) return;
  matchmakingTimer = setInterval(() => { void runMatchmakingTick(); }, MATCHMAKING_INTERVAL_MS);
  if (typeof matchmakingTimer.unref === 'function') matchmakingTimer.unref();
}

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[bootstrap] received ${signal}, shutting down...`);
  if (matchmakingTimer) clearInterval(matchmakingTimer);
  await new Promise((resolve) => server.close(resolve));
  process.exit(0);
}

async function bootstrap() {
  try {
    setupCoreMiddleware();
    setupRoutes();
    await initSchema();
    server.listen(PORT, HOST, () => console.log(`TRUST backend listening on ${HOST}:${PORT}`));
    startMatchmakingLoop();
    process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
  } catch (e) {
    console.error('[bootstrap] failed to start:', e);
    process.exit(1);
  }
}
void bootstrap();
