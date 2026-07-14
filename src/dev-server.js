// Offline mode: a real MongoDB in a temp directory, thrown away on exit.
//
// Useful when Atlas is unreachable (a blocked IP, no network). Same models, same
// state machine, same code paths as production — only the storage is temporary.
//
// It creates NOTHING but the admin account. There is no demo data anywhere in this
// project: staff are created by the admin in the dashboard, patients register
// themselves, and orders appear when a patient sends a prescription.
//
// Use `npm run dev` / `npm start` against MONGODB_URI for anything you want to keep.

require('dotenv').config();
const http = require('http');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const bcrypt = require('bcryptjs');

const app = require('./app');
const { attach } = require('./realtime');
const { Staff } = require('./models');

const port = process.env.PORT || 5000;

async function start() {
  const username = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;

  if (!password || password.length < 6) {
    throw new Error('ADMIN_PASSWORD is required (6+ characters). Set it in backend/.env');
  }

  console.log('  Starting in-memory MongoDB…');
  // WiredTiger can take well over the library's 10s default to open on a cold
  // Windows disk, which surfaces as a bogus "failed to start" error.
  const mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
  await mongoose.connect(mongod.getUri());

  await Staff.create({
    name: process.env.ADMIN_NAME || 'Administrator',
    username,
    password: await bcrypt.hash(password, 10),
    role: 'admin',
    zone: 'All',
    active: true,
  });

  const server = http.createServer(app);
  attach(server);

  server.listen(port, '0.0.0.0', () => {
    console.log('\n  Heritage Diagnostics API — OFFLINE MODE (nothing is saved)');
    console.log(`  http://localhost:${port}/api/health\n`);
    console.log(`  Admin: ${username} (password from ADMIN_PASSWORD)`);
    console.log('  Everything else is created through the product:');
    console.log('   • PRO / Agent / Lab  -> admin dashboard');
    console.log('   • Patients           -> register in the app\n');
  });

  const shutdown = async () => {
    server.close();
    await mongoose.disconnect();
    await mongod.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch(error => { console.error(`\n${error.message}\n`); process.exit(1); });
