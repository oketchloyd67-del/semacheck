
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');

const { generalLimiter } = require('./middleware/rateLimiter');
const { requestId } = require('./middleware/requestId');
const { apiKeyAuth } = require('./middleware/apiKeyAuth');
const { apiRateLimit } = require('./middleware/apiRateLimit');
const { quotaMeter } = require('./middleware/quotaMeter');
const { widgetOrigin } = require('./middleware/widgetOrigin');
const { reportAbuseGuard } = require('./middleware/reportAbuseGuard');
const apiV1Routes = require('./routes/apiV1');
const reportsRoutes = require('./routes/reports');
const apiAccountRoutes = require('./routes/apiAccount');
const publicStatsRoutes = require('./routes/publicStats');
const whatsappRoutes = require('./routes/whatsapp');
const publicRoutes = require('./routes/public');
const authRoutes = require('./routes/auth');
const searchRoutes = require('./routes/search');
const paymentRoutes = require('./routes/payments');
const jobRoutes = require('./routes/jobs');
const adminRoutes = require('./routes/admin');
const contactRoutes = require('./routes/contact');
const forensicsRoutes = require('./routes/forensics');
const notificationsRoutes = require('./routes/notifications');
const feedbackRoutes = require('./routes/feedback');

const app = express();

// Express 4 does not catch rejected promises from async route handlers — on
// Node >= 15 an unhandled rejection is fatal, so a single SQL error used to
// take the whole API down (every endpoint answered 503 with no CORS headers,
// which the dashboard reported as "Offline"). Wrap every route handler so any
// thrown/rejected error flows into the JSON error middleware instead.
function wrapAsyncHandlers(router) {
  (router.stack || []).forEach((layer) => {
    if (layer.route) {
      (layer.route.stack || []).forEach((routeLayer) => {
        const handler = routeLayer.handle;
        if (typeof handler !== 'function' || handler.length >= 4) return; // error middleware
        routeLayer.handle = function guarded(req, res, next) {
          try {
            const result = handler.apply(this, arguments);
            if (result && typeof result.then === 'function') result.catch(next);
          } catch (err) {
            next(err);
          }
        };
      });
    } else if (layer.handle && layer.handle.stack) {
      wrapAsyncHandlers(layer.handle); // nested router
    }
  });
  return router;
}

[
  apiV1Routes, reportsRoutes, apiAccountRoutes, publicStatsRoutes,
  whatsappRoutes, publicRoutes, authRoutes, searchRoutes, paymentRoutes,
  jobRoutes, adminRoutes, contactRoutes, forensicsRoutes, notificationsRoutes,
].forEach(wrapAsyncHandlers);

// Last line of defence: log, never silently die.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] Unhandled promise rejection (kept alive):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[fatal] Uncaught exception:', err && err.stack ? err.stack : err);
});

app.use('/whatsapp', whatsappRoutes);
app.set('trust proxy', 1); 
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  strictTransportSecurity: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: false,
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  crossOriginResourcePolicy: false,
}));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  // This server returns JSON only, so a locked-down CSP is safe (review 10.1).
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.removeHeader('X-Powered-By');
  next();
});
app.use(compression());
const allowedOrigins = (process.env.ALLOWED_ORIGIN || '*').split(',').map((s) => s.trim()).filter(Boolean);
// Always allow the first-party deployments, regardless of what is (or isn't)
// set in ALLOWED_ORIGIN — a missing env var used to turn every cross-origin
// request into a CORS failure.
const firstPartyOrigins = [
  'https://contsemacheck.vercel.app',
  'https://semacheck.vercel.app',
  'https://semacheck-admin.vercel.app',
  'https://semacheck.onrender.com',
];
app.use(cors({
  origin: (origin, callback) => {
    const allowed = !origin
      || allowedOrigins.includes('*')
      || allowedOrigins.includes(origin)
      || firstPartyOrigins.includes(origin);
    if (!allowed) console.warn(`[cors] Blocked origin: ${origin}`);
    // Never throw here — an exception in this callback skips the CORS headers
    // and surfaces to the browser as an unreadable "CORS error".
    callback(null, allowed);
  },
  credentials: true,
}));


app.use('/api/payments/tuma/callback', express.json({ limit: '50kb' }));

app.use(express.json({ limit: '100kb', strict: true }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(generalLimiter);

app.get('/api/health', (req, res) => {
  const health = {
    status: 'ok',
    time: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB',
    },
    db: 'connected',
    redis: process.env.REDIS_URL ? 'configured' : 'not configured',
  };
  res.json(health);
});

app.get('/api/ping', (req, res) => res.json({ pong: true, time: Date.now() }));

// ---- Trust Check API ----
// /v1/* — API-key authenticated
app.use('/v1', apiV1Routes);

// Public report + alerts
app.use('/api/reports', reportsRoutes);

// Customer API account dashboard (session auth, verified email required).
// The routes inside are prefixed /api/… (e.g. /api/overview, /api/keys), so
// the mounted paths are /api/account/api/* — matching every frontend call
// and the route comments in routes/apiAccount.js.
app.use('/api/account/api', apiAccountRoutes);

// Transparency page — 10-minute cache
app.use('/api/public/stats', publicStatsRoutes);

const KEEPALIVE_INTERVAL_MS = 10 * 60 * 1000;
function startKeepAlive() {
  setInterval(() => {
    const http = require('http');
    const url = `http://127.0.0.1:${PORT}/api/ping`;
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => console.log('Keep-alive ping:', body.substring(0, 80)));
    }).on('error', (e) => console.error('Keep-alive ping failed:', e.message));
  }, KEEPALIVE_INTERVAL_MS);
  console.log(`Keep-alive pinger started (every ${KEEPALIVE_INTERVAL_MS / 1000}s)`);
}

app.use('/api/public', publicRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/admin', adminRoutes); 
app.use('/api/contact', contactRoutes);
app.use('/api/forensics', forensicsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/feedback', feedbackRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));


app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

const PORT = process.env.PORT || 4800;
app.listen(PORT, () => {
  // Make optional-module problems visible immediately in the Render logs
  // (they were previously swallowed and only discovered weeks later).
  ['web-push', 'pdf-parse'].forEach((dep) => {
    try { require(dep); console.log(`[deps] ${dep}: OK`); }
    catch (e) { console.error(`[deps] ${dep} FAILED to load:`, e && e.message ? e.message : e); }
  });

  // Self-heal the schema on boot. Render's free tier has no shell and the
  // build command is not guaranteed to run migrations, so apply the idempotent
  // schema on every start instead of letting the DB drift behind the code.
  if (process.env.SKIP_STARTUP_MIGRATE !== 'true') {
    require('./db/migrate').migrate({ closePool: false })
      .then(() => console.log('Startup schema migration OK.'))
      .catch((e) => console.error('Startup schema migration failed:', e && e.message ? e.message : e));
  }
  console.log(`SemaCheck API listening on port ${PORT}`);
  console.log('Tuma config:', {
    hasEmail: !!process.env.TUMA_EMAIL,
    hasApiKey: !!process.env.TUMA_API_KEY,
    hasCallbackUrl: !!process.env.TUMA_CALLBACK_URL,
    callbackUrl: process.env.TUMA_CALLBACK_URL || 'NOT SET',
  });
  startKeepAlive();
});

if (process.env.DISABLE_IN_PROCESS_SCHEDULER !== 'true') {
  const { runMaintenance } = require('./jobs/subscriptionMaintenance');
  setTimeout(() => runMaintenance().catch((e) => console.error('Subscription maintenance failed:', e)), 30_000);
  setInterval(() => runMaintenance().catch((e) => console.error('Subscription maintenance failed:', e)), 24 * 60 * 60 * 1000);

  
  const { run: refreshKenyaRegistries } = require('./jobs/refreshKenyaRegistries');
  setTimeout(() => refreshKenyaRegistries().catch((e) => console.error('CBK registry refresh failed:', e.message)), 45_000);
  setInterval(() => refreshKenyaRegistries().catch((e) => console.error('CBK registry refresh failed:', e.message)), 7 * 24 * 60 * 60 * 1000);

  const { run: refreshInternationalDbs } = require('./jobs/refreshInternationalDatabases');
  setTimeout(() => refreshInternationalDbs().catch((e) => console.error('International databases refresh failed:', e.message)), 60_000);
  setInterval(() => refreshInternationalDbs().catch((e) => console.error('International databases refresh failed:', e.message)), 7 * 24 * 60 * 60 * 1000);

  // API plan renewal reminders — emails paid-plan owners within 3 days of renewal.
  const { run: runApiPlanReminders } = require('./jobs/apiPlanReminders');
  setTimeout(() => runApiPlanReminders().catch((e) => console.error('API plan reminders failed:', e.message)), 90_000);
  setInterval(() => runApiPlanReminders().catch((e) => console.error('API plan reminders failed:', e.message)), 24 * 60 * 60 * 1000);
}

module.exports = app;
