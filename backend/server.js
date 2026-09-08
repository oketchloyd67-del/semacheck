
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');

const { generalLimiter } = require('./middleware/rateLimiter');
const whatsappRoutes = require('./routes/whatsapp');
const publicRoutes = require('./routes/public');
const authRoutes = require('./routes/auth');
const searchRoutes = require('./routes/search');
const paymentRoutes = require('./routes/payments');
const jobRoutes = require('./routes/jobs');
const adminRoutes = require('./routes/admin');
const contactRoutes = require('./routes/contact');
const forensicsRoutes = require('./routes/forensics');

const app = express();

app.use('/whatsapp', whatsappRoutes);
app.set('trust proxy', 1); 
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(compression());
const allowedOrigins = (process.env.ALLOWED_ORIGIN || '*').split(',').map((s) => s.trim());
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));


app.use('/api/payments/tuma/callback', express.json());

app.use(express.json({ limit: '100kb' }));
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

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));


app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

const PORT = process.env.PORT || 4800;
app.listen(PORT, () => {
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
}

module.exports = app;
