require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const cookieParser = require('cookie-parser');

const config = require('./config');
const { pool } = require('./db');
const { ok } = require('./utils/http');
const { runMatchmakingCycle } = require('./services/queueService');

const authRoutes = require('./routes/auth.routes');
const accountRoutes = require('./routes/account.routes');
const partyRoutes = require('./routes/party.routes');
const queueRoutes = require('./routes/queue.routes');
const matchesRoutes = require('./routes/matches.routes');
const leaderboardRoutes = require('./routes/leaderboard.routes');
const internalRoutes = require('./routes/internal.routes');
const launcherRoutes = require('./routes/launcher.routes');

const app = express();
app.set('trust proxy', 1);

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (config.allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true
}));

app.use(express.json());
app.use(cookieParser());
app.use(session({
  store: new PgSession({
    pool,
    tableName: 'user_sessions',
    createTableIfMissing: true
  }),
  name: 'trust.sid',
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: config.cookieSecure ? 'none' : 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 30
  }
}));

app.get('/', (req, res) => ok(res, { service: 'trust-backend', version: '2.0.1' }));
app.get('/health', async (req, res, next) => {
  try {
    await pool.query('SELECT 1');
    return ok(res, { status: 'online', timestamp: Date.now() });
  } catch (err) {
    return next(err);
  }
});
app.get('/config', (req, res) => ok(res, {
  config: {
    appName: 'TRUST',
    latestVersion: '0.2.0',
    matchmakingEnabled: true,
    maintenance: false,
    motd: 'TRUST backend is online',
    mode: config.defaultMatchMode
  }
}));

app.use('/auth', authRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/party', partyRoutes);
app.use('/api/queue', queueRoutes);
app.use('/api/web-queue', queueRoutes);
app.use('/api/matches', matchesRoutes);
app.use('/api/leaderboard', leaderboardRoutes);
app.use('/internal', internalRoutes);
app.use('/launcher', launcherRoutes);

app.use((err, req, res, next) => {
  console.error('unhandled error:', err);
  if (err && typeof err.message === 'string' && err.message.startsWith('CORS blocked')) {
    return res.status(403).json({ ok: false, error: 'cors_blocked' });
  }
  res.status(500).json({ ok: false, error: 'internal_error' });
});

setInterval(async () => {
  try {
    await runMatchmakingCycle();
  } catch (err) {
    console.error('matchmaking cycle error:', err);
  }
}, config.matchmakingIntervalMs);

app.listen(config.port, () => {
  console.log(`TRUST backend listening on :${config.port}`);
});
