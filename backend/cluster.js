// cluster.js — optional entry point for production: `node cluster.js`
// Forks one worker per CPU core so the app uses all available cores
// instead of Node's single-threaded default. Combine with REDIS_URL
// (see middleware/rateLimiter.js) so rate limits are shared correctly
// across workers, and with PG_POOL_MAX sized so (workers x pool size)
// stays under your Postgres max_connections.
const cluster = require('cluster');
const os = require('os');

if (cluster.isMaster || cluster.isPrimary) {
  const numWorkers = parseInt(process.env.CLUSTER_WORKERS || os.cpus().length, 10);
  console.log(`Starting SemaCheck in cluster mode with ${numWorkers} workers...`);
  for (let i = 0; i < numWorkers; i++) cluster.fork();

  cluster.on('exit', (worker, code, signal) => {
    console.error(`Worker ${worker.process.pid} died (${signal || code}). Restarting...`);
    cluster.fork();
  });
} else {
  require('./server');
}
