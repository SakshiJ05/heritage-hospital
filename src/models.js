const mongoose = require('mongoose');
const { ALL_STATUSES, STATUS } = require('./status');

const patientSchema = new mongoose.Schema({
  phone: { type: String, unique: true, required: true, index: true },
  name: { type: String, default: 'ग्राहक' },
  village: String,
  address: String,

  // Patients sign in with a password today. The OTP fields below are kept because
  // AUTH_MODE flips the app back to SMS OTP without a migration — see src/auth.js.
  password: String,

  otpHash: String,
  otpExpiry: Date,
  otpAttempts: { type: Number, default: 0 },

  loginAttempts: { type: Number, default: 0 },
  lockedUntil: Date,

  voiceGuidance: { type: Boolean, default: true },
  pushToken: String,
}, { timestamps: true });

const staffSchema = new mongoose.Schema({
  name: { type: String, required: true },
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['pro', 'agent', 'lab', 'admin'], required: true },
  phone: String,
  zone: String,
  active: { type: Boolean, default: true },
  pushToken: String,
}, { timestamps: true });

const orderSchema = new mongoose.Schema({
  orderId: { type: String, unique: true, index: true },
  patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },

  // A prescription can run to several pages/photos. prescriptionUrls holds them all;
  // prescriptionUrl stays as the first one so older builds and old orders — which
  // only ever had a single image — keep rendering unchanged.
  prescriptionUrl: String,
  prescriptionUrls: [String],
  // Names kept as a plain array (unchanged) so every old order still renders and
  // `tests.join(', ')` keeps working everywhere. testItems is the per-test rate
  // snapshot taken at confirm time — frozen, so editing a catalog rate later never
  // rewrites a past order's amount.
  tests: [String],
  testItems: [{ _id: false, name: String, amount: Number }],
  amount: { type: Number, default: 0 },
  paymentMode: { type: String, enum: ['cash', 'online'], default: 'cash' },
  paymentCollected: { type: Boolean, default: false },
  village: String,
  address: String,

  status: { type: String, enum: ALL_STATUSES, default: STATUS.SUBMITTED, index: true },

  pro: { type: mongoose.Schema.Types.ObjectId, ref: 'Staff' },
  proCalled: { type: Boolean, default: false },
  proConfirmed: { type: Boolean, default: false },

  assignedAgent: { type: mongoose.Schema.Types.ObjectId, ref: 'Staff', index: true },
  pickupSlot: String,
  sampleTaken: { type: Boolean, default: false },
  cashTaken: { type: Boolean, default: false },

  labTube: { type: String, enum: ['EDTA', 'SST', 'FLU'] },
  labReceivedAt: Date,
  reportUrl: String,

  cancelReason: String,
}, { timestamps: true });

// Order codes are handed out by an atomic counter rather than a timestamp slice.
// `HD-${Date.now().slice(-6)}` (the old scheme) collides whenever two orders are
// created in the same millisecond, and `orderId` is a unique index.
const counterSchema = new mongoose.Schema({
  _id: String,
  seq: { type: Number, default: 0 },
});
const Counter = mongoose.model('Counter', counterSchema);

// Codes start at HD-1041, continuing the series the demo data already used.
// ($inc on an upsert ignores the schema default, so the offset lives here.)
const ORDER_CODE_BASE = 1040;

orderSchema.pre('validate', async function () {
  if (this.orderId) return;
  const counter = await Counter.findByIdAndUpdate(
    'order',
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  this.orderId = `HD-${ORDER_CODE_BASE + counter.seq}`;
});

// Powers the patient's step tracker and gives us an audit trail of who moved what.
const statusHistorySchema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
  status: { type: String, enum: ALL_STATUSES, required: true },
  changedByStaff: { type: mongoose.Schema.Types.ObjectId, ref: 'Staff' },
  note: String,
}, { timestamps: { createdAt: 'timestamp', updatedAt: false } });

const notificationSchema = new mongoose.Schema({
  patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', index: true },
  staff: { type: mongoose.Schema.Types.ObjectId, ref: 'Staff', index: true },
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  type: String,

  // Both languages are stored at write time. A notification is a record of what
  // was said, so translating it later in the client would be a lie — but the UI
  // still has to follow the reader's language toggle, so we keep both.
  message: String,      // Hindi
  messageEn: String,

  channels: [String],
  read: { type: Boolean, default: false },
}, { timestamps: true });

// The master price list. The PRO picks tests from this at confirm time and the
// server sums their rates — the amount is never typed by hand. Soft-deleted
// (isActive:false) rather than removed, so a test that once priced an old order
// still resolves for that order's history.
const testCatalogSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  category: { type: String, default: '', trim: true },
  amount: { type: Number, required: true, min: 0 },
  isActive: { type: Boolean, default: true, index: true },
}, { timestamps: true });

module.exports = {
  Patient: mongoose.model('Patient', patientSchema),
  Staff: mongoose.model('Staff', staffSchema),
  Order: mongoose.model('Order', orderSchema),
  OrderStatusHistory: mongoose.model('OrderStatusHistory', statusHistorySchema),
  Notification: mongoose.model('Notification', notificationSchema),
  TestCatalog: mongoose.model('TestCatalog', testCatalogSchema),
  Counter,
};
