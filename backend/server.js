
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');

const { generalLimiter } = require('./middleware/rateLimiter');
const whatsappRoutes = require('./routes/whatsapp');
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
app.use(helmet());
app.use(compression());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*', credentials: true }));


app.use('/api/payments/tuma/callback', express.json());

app.use(express.json({ limit: '100kb' }));
app.use(generalLimiter);

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

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
app.listen(PORT, () => console.log(`SemaCheck API listening on port ${PORT}`));

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
