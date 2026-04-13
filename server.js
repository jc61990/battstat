'use strict';

const express    = require('express');
const http       = require('http');
const path       = require('path');
const { WebSocketServer } = require('ws');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const routes     = require('./routes');
const authRoutes = require('./auth/routes');
const { getTokenFromRequest } = require('./auth/middleware');
const db         = require('./db');
const { startPoller, registerWsClient, unregisterWsClient } = require('./poller');
const { execFileSync } = require('child_process');

// Run DB migrations on every startup — idempotent, safe, fast
try {
  execFileSync(process.execPath, [path.join(__dirname, 'scripts', 'migrate.js')], {
    env: { ...process.env, DB_PATH: process.env.DB_PATH || path.join(__dirname, 'data', 'ups-monitor.db') },
    stdio: 'inherit',
  });
} catch (e) {
  console.error('[startup] Migration failed:', e.message);
  process.exit(1);
}

const PORT           = parseInt(process.env.PORT  || '3000', 10);
const HOST           = process.env.HOST            || '127.0.0.1';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN  || '';

const app = express();
app.set('trust proxy', false);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      imgSrc:     ["'self'", 'data:'],
      frameSrc:   ["'none'"],
      objectSrc:  ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '16kb' }));

app.use('/api', rateLimit({ windowMs: 60000, max: 120, standardHeaders: true, legacyHeaders: false }));
app.use('/api/poll/device', rateLimit({ windowMs: 60000, max: 20, standardHeaders: true, legacyHeaders: false }));

app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: '1m' }));

app.use('/api/auth', authRoutes);
app.use('/api',      routes);

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('*', (req, res, next) => {
  const token   = getTokenFromRequest(req);
  const session = token ? db.getSession(token) : null;
  if (!session) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, _next) => {
  console.error('[error]', err.message);
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

const server = http.createServer(app);

function isOriginAllowed(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGIN) return origin === ALLOWED_ORIGIN;
  try {
    const url = new URL(origin);
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  } catch (_) { return false; }
}

const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: ({ req }, done) => {
    const origin = req.headers['origin'];
    if (!isOriginAllowed(origin)) { done(false, 403, 'Forbidden'); return; }
    const cookie = req.headers['cookie'] || '';
    const match  = cookie.match(/ups_session=([a-f0-9]{64})/);
    const token  = match ? match[1] : null;
    if (!token) { done(false, 401, 'Unauthorized'); return; }
    const session = db.getSession(token);
    if (!session) { done(false, 401, 'Session expired'); return; }
    done(true);
  },
});

wss.on('connection', (ws) => {
  registerWsClient(ws);
  ws.on('close',   () => unregisterWsClient(ws));
  ws.on('error',   () => unregisterWsClient(ws));
  ws.on('message', () => {});
});

setInterval(() => db.pruneExpiredSessions(), 15 * 60 * 1000);

server.listen(PORT, HOST, () => {
  console.log(`[server] UPS Monitor running at http://${HOST}:${PORT}`);
  startPoller();
});

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { server.close(() => process.exit(0)); });
