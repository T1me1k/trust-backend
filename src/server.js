const http = require('http');
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const passport = require('passport');

const config = require('./config');
const { initSchema } = require('./db/initSchema');
const { runMatchmakingCycle } = require('./services/queueService');

const authRoutes = require('./routes/auth.routes');
const partyRoutes = require('./routes/party.routes');
const queueRoutes = require('./routes/queue.routes');
const matchRoutes = require('./routes/match.routes');
const publicRoutes = require('./routes/public.routes');
const launcherRoutes = require('./routes/launcher.routes');

const PORT = Number(process.env.PORT || config.port || 3000);
const HOST = '0.0.0.0';
const MATCHMAKING_INTERVAL_MS = Number(
  process.env.MATCHMAKING_INTERVAL_MS || config.matchmakingIntervalMs || 3000
);

const app = express();
const server = http.createServer(app);

let matchmakingTimer = null;
let matchmakingRunning = false;
let shuttingDown = false;

function getAllowedOrigins() {
  const raw = config.allowedOrigins || process.env.ALLOWED_ORIGINS || '';
  return String(raw)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function setupCoreMiddleware() {
  const allowedOrigins = getAllowedOrigins();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.length === 0) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error(`CORS blocked for origin: ${origin}`));
      },
      credentials: true
    })
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser());

  app.use(
    session({
      name: 'trust.sid',
      secret: process.env.SESSION_SECRET || config.sessionSecret || 'change-me',
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        secure: String(process.env.COOKIE_SECURE || config.cookieSecure || 'false') === 'true',
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 24 * 30
      }
    })
  );

  app.use(passport.initialize());
  app.use(passport.session());
}

function setupRoutes() {
  app.get('/health', async (_req, res) => {
    res.status(200).json({
      ok: true,
      service: 'trust-backend',
      uptimeSec: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    });
  });

  app.get('/config', async (_req, res) => {
    res.status(200).json({
      ok: true,
      app: 'TRUST',
      version: '2.0.2',
      mode: process.env.DEFAULT_MATCH_MODE || config.defaultMatchMode || '2x2',
      region: process.env.DEFAULT_REGION || config.defaultRegion || 'EU'
    });
  });

  app.use('/auth', authRoutes);
  app.use('/api/auth', authRoutes);

  app.use('/party', partyRoutes);
  app.use('/api/party', partyRoutes);

  app.use('/queue', queueRoutes);
  app.use('/api/queue', queueRoutes);

  app.use('/match', matchRoutes);
  app.use('/api/match', matchRoutes);

  app.use('/launcher', launcherRoutes);
  app.use('/api/launcher', launcherRoutes);

  app.use('/', publicRoutes);
  app.use('/api', publicRoutes);

  app.use((req, res) => {
    res.status(404).json({
      ok: false,
      error: 'not_found',
      path: req.originalUrl
    });
  });

  app.use((err, _req, res, _next) => {
    const message = err && err.message ? err.message : 'internal_error';
    const status = err && err.statusCode ? err.statusCode : 500;

    console.error('[http] unhandled error:', err);

    res.status(status).json({
      ok: false,
      error: message
    });
  });
}

async function runMatchmakingTick() {
  if (matchmakingRunning || shuttingDown) return;

  matchmakingRunning = true;
  try {
    await runMatchmakingCycle();
  } catch (error) {
    console.error('matchmaking cycle error:', error);
  } finally {
    matchmakingRunning = false;
  }
}

function startMatchmakingLoop() {
  if (matchmakingTimer) return;

  matchmakingTimer = setInterval(() => {
    void runMatchmakingTick();
  }, MATCHMAKING_INTERVAL_MS);

  if (typeof matchmakingTimer.unref === 'function') {
    matchmakingTimer.unref();
  }

  console.log(`[matchmaking] loop started (${MATCHMAKING_INTERVAL_MS} ms)`);
}

function stopMatchmakingLoop() {
  if (!matchmakingTimer) return;
  clearInterval(matchmakingTimer);
  matchmakingTimer = null;
  console.log('[matchmaking] loop stopped');
}

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[bootstrap] received ${signal}, shutting down...`);

  stopMatchmakingLoop();

  await new Promise((resolve) => {
    server.close(() => resolve());
  });

  console.log('[bootstrap] shutdown complete');
  process.exit(0);
}

async function bootstrap() {
  try {
    setupCoreMiddleware();
    setupRoutes();

    await initSchema();

    server.listen(PORT, HOST, () => {
      console.log(`TRUST backend listening on ${HOST}:${PORT}`);
    });

    startMatchmakingLoop();

    process.on('SIGTERM', () => {
      void gracefulShutdown('SIGTERM');
    });

    process.on('SIGINT', () => {
      void gracefulShutdown('SIGINT');
    });

    process.on('unhandledRejection', (reason) => {
      console.error('[process] unhandledRejection:', reason);
    });

    process.on('uncaughtException', (error) => {
      console.error('[process] uncaughtException:', error);
    });
  } catch (error) {
    console.error('[bootstrap] failed to start:', error);
    process.exit(1);
  }
}

void bootstrap();
