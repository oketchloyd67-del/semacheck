// cluster.js 
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
