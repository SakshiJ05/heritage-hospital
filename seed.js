// Bootstraps a REAL, empty system.
//
// There is no demo data here on purpose. The only thing this creates is the one
// admin account you need to get in. Everything else is made through the product:
//   • PRO / Agent / Lab accounts  -> Admin dashboard -> "+ नया … खाता"
//   • Patients                    -> they register themselves in the app
//   • Orders                      -> a patient sends a prescription
//
//   npm run seed            create the admin if it does not exist
//   npm run seed -- --reset WIPE EVERYTHING (patients, staff, orders, history,
//                           notifications) and recreate only the admin
//
// The admin's credentials come from the environment, so they are not baked into
// the repository:
//   ADMIN_USERNAME (default: admin)
//   ADMIN_PASSWORD (required — the script refuses to invent one)

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const { Patient, Staff, Order, OrderStatusHistory, Notification, TestCatalog, Counter } = require('./src/models');
const { configureDns } = require('./src/dns');

// A starter price list so the PRO's picker isn't empty on day one. Seeded only when
// the catalog is empty, and the admin can edit/add/disable any of it in the panel.
const SAMPLE_TESTS = [
  { name: 'CBC (Complete Blood Count)', category: 'Blood Test', amount: 300 },
  { name: 'Blood Sugar (Fasting)', category: 'Blood Test', amount: 150 },
  { name: 'Blood Sugar (PP)', category: 'Blood Test', amount: 150 },
  { name: 'HbA1c', category: 'Blood Test', amount: 450 },
  { name: 'Lipid Profile', category: 'Profile', amount: 500 },
  { name: 'Thyroid Profile (T3 T4 TSH)', category: 'Profile', amount: 650 },
  { name: 'Liver Function Test (LFT)', category: 'Profile', amount: 600 },
  { name: 'Kidney Function Test (KFT)', category: 'Profile', amount: 600 },
  { name: 'Vitamin D', category: 'Blood Test', amount: 1200 },
  { name: 'Vitamin B12', category: 'Blood Test', amount: 900 },
  { name: 'Chest X-Ray', category: 'Radiology', amount: 400 },
  { name: 'ECG', category: 'Cardiology', amount: 300 },
];

async function run() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');

  const username = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;

  if (!password || password.length < 6) {
    throw new Error(
      'ADMIN_PASSWORD is required (6+ characters). Set it in backend/.env — it is not stored in the repo.',
    );
  }

  configureDns();
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  console.log(`MongoDB: ${mongoose.connection.host} · database "${mongoose.connection.name}"`);

  const reset = process.argv.includes('--reset');

  if (reset) {
    const [orders, patients, staff, history, notes] = await Promise.all([
      Order.countDocuments(), Patient.countDocuments(), Staff.countDocuments(),
      OrderStatusHistory.countDocuments(), Notification.countDocuments(),
    ]);
    console.log(
      `\n  WIPING: ${orders} orders · ${patients} patients · ${staff} staff · ` +
      `${history} history rows · ${notes} notifications`,
    );

    await Promise.all([
      Order.deleteMany({}),
      Patient.deleteMany({}),
      Staff.deleteMany({}),
      OrderStatusHistory.deleteMany({}),
      Notification.deleteMany({}),
      TestCatalog.deleteMany({}),
      Counter.deleteMany({}),   // order codes restart at HD-1041
    ]);
    console.log('  Database is now empty.\n');
  }

  // Seed the price list once (skipped if the admin has already built their own).
  if (await TestCatalog.countDocuments() === 0) {
    await TestCatalog.insertMany(SAMPLE_TESTS);
    console.log(`Test catalog seeded with ${SAMPLE_TESTS.length} sample tests.`);
  }

  const existing = await Staff.findOne({ username });
  if (existing) {
    // Keep the password in step with .env, so a forgotten password is one re-run away.
    existing.password = await bcrypt.hash(password, 10);
    existing.role = 'admin';
    existing.active = true;
    await existing.save();
    console.log(`Admin "${username}" already existed — password reset from ADMIN_PASSWORD.`);
  } else {
    await Staff.create({
      name: process.env.ADMIN_NAME || 'Administrator',
      username,
      password: await bcrypt.hash(password, 10),
      role: 'admin',
      zone: 'All',
      active: true,
    });
    console.log(`Admin "${username}" created.`);
  }

  const [patients, staff, orders] = await Promise.all([
    Patient.countDocuments(), Staff.countDocuments(), Order.countDocuments(),
  ]);

  console.log(`\n  Patients: ${patients}   Staff: ${staff}   Orders: ${orders}`);
  console.log('\n  Next:');
  console.log('   1. Log into the admin dashboard as this user.');
  console.log('   2. Create the PRO / Agent / Lab accounts there.');
  console.log('   3. Register a patient in the app and send a prescription.\n');

  await mongoose.disconnect();
}

run().catch(error => { console.error(`\n${error.message}\n`); process.exit(1); });
