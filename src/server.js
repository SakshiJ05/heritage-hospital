require('dotenv').config();
const http = require('http');
const os = require('os');
const mongoose = require('mongoose');
const app = require('./app');
const { configureDns } = require('./dns');
const { attach } = require('./realtime');

const port = process.env.PORT || 5000;

// The phone running the APK cannot reach "localhost" — that is the phone itself.
// Print the LAN address so it is obvious what to put in the app's config.
function lanAddress() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
}

async function start() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');

  configureDns();
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });

  const { host, name } = mongoose.connection;
  console.log(`MongoDB: ${host} · database "${name}"`);

  // Express and Socket.io share one HTTP server, so both live on the same port.
  const server = http.createServer(app);
  attach(server);

  // 0.0.0.0, not localhost — otherwise a phone on the same Wi-Fi cannot connect.
  server.listen(port, '0.0.0.0', () => {
    const lan = lanAddress();
    console.log(`Heritage Diagnostics API: http://localhost:${port}`);
    if (lan) console.log(`On this network (use this in the APK): http://${lan}:${port}`);
    console.log(`Health check: http://localhost:${port}/api/health`);
  });

  return server;
}

if (require.main === module) {
  start().catch(error => { console.error(error); process.exit(1); });
}

module.exports = { app, start, lanAddress };
