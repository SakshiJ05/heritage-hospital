// Adds only missing standard tests to the configured database. Existing rates,
// categories and disabled states remain untouched.
require('dotenv').config();
const mongoose = require('mongoose');

const { TestCatalog } = require('./src/models');
const { configureDns } = require('./src/dns');
const { syncStandardTests } = require('./src/standard-tests');

async function run() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  configureDns();
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  const result = await syncStandardTests(TestCatalog);
  console.log(`Test catalog synced: ${result.added} added, ${result.total} total.`);
  await mongoose.disconnect();
}

run().catch(error => { console.error(error.message); process.exit(1); });
