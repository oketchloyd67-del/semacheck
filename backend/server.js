// server.js
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');

const { generalLimiter } = require('./middleware/rateLimiter');
const authRoutes = require('./routes/auth');
const searchRoutes = require('./routes/search');
const paymentRoutes = require('./routes/payments');
const jobRoutes = require('./routes/jobs');
const adminRoutes = require('./routes/admin');
const contactRoutes = require('./routes/contact');

const app = express();

app.set('trust proxy', 1); // needed for correct req.ip behind a load balancer/reverse proxy
app.use(helmet());
app.use(compression());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*', credentials: true }));

// The Tuma payment callback needs raw JSON before any auth, mounted first.
app.use('/api/payments/tuma/callback', express.json());

app.use(express.json({ limit: '100kb' }));
app.use(generalLimiter);

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.use('/api/auth', authRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/admin', adminRoutes); // not linked from the public site — see routes/admin.js
app.use('/api/contact', contactRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

const PORT = process.env.PORT || 4800;
app.listen(PORT, () => console.log(`SemaCheck API listening on port ${PORT}`));

// ---- subscription maintenance (expiry + renewal reminders) ----
// Convenience fallback so this works out of the box without extra ops
// setup: runs once shortly after boot, then every 24h. For production,
// prefer a real cron/systemd timer running `npm run reminders` instead —
// a long-lived Node process isn't a reliable substitute for a real
// scheduler (it resets on every deploy/restart, and running it here
// means every clustered worker would also try to run it unless you
// guard against that). Set DISABLE_IN_PROCESS_SCHEDULER=true in .env
// once you've set up a real cron job, to avoid doing both.
if (process.env.DISABLE_IN_PROCESS_SCHEDULER !== 'true') {
  const { runMaintenance } = require('./jobs/subscriptionMaintenance');
  setTimeout(() => runMaintenance().catch((e) => console.error('Subscription maintenance failed:', e)), 30_000);
  setInterval(() => runMaintenance().catch((e) => console.error('Subscription maintenance failed:', e)), 24 * 60 * 60 * 1000);
}

module.exports = app;
