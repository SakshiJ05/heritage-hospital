const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcryptjs');

const { Patient, Staff, Order, OrderStatusHistory, Notification, TestCatalog } = require('./models');
const { sign, auth, allow, hashOtp, compareOtp } = require('./auth');
const { STATUS, STEPS, QUEUES, stepIndex, ALL_STATUSES } = require('./status');
const { moveTo, populateOrder } = require('./lifecycle');
const { notifyStaff } = require('./notifications');
const { emitOrderCreated, emitOrderUpdated } = require('./realtime');

const app = express();

const uploadRoot = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));
fs.mkdirSync(uploadRoot, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadRoot,
    // Unguessable name: the old scheme used the original filename, and /uploads is
    // static, so a predictable name meant a readable prescription.
    filename: (_req, file, cb) =>
      cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase().slice(0, 8)}`),
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.mimetype);
    cb(ok ? null : Object.assign(new Error('unsupported_file_type'), { status: 400 }), ok);
  },
});

app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') || '*' }));
app.use(express.json());
app.use('/uploads', express.static(uploadRoot));

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, code, message) => Object.assign(new Error(code), { status, code, message });

// LAB accounts need enough data to identify a sample and prepare its report, but
// not the admin/PRO view of the patient. Keep this restriction on the server (not
// merely hidden in the web UI), so a LAB user cannot recover phone, address,
// amount, prescription or staff details from the browser's Network panel.
const labOrderView = order => {
  if (!order) return order;
  const plain = typeof order.toObject === 'function' ? order.toObject() : order;
  const patient = plain.patient && typeof plain.patient === 'object'
    ? { _id: plain.patient._id, name: plain.patient.name }
    : undefined;
  return {
    _id: plain._id,
    orderId: plain.orderId,
    status: plain.status,
    tests: plain.tests || [],
    patient,
    labTube: plain.labTube,
    reportUrl: plain.reportUrl,
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
  };
};

// A real Indian mobile number: exactly ten digits, and the first is 6-9. Every
// live SIM-issued mobile falls in that range, so this rejects the junk that a plain
// length check waves through — 0000000000, 1234567890, a landline STD code — while
// still accepting every genuine number. Callers pass the already-\D-stripped string.
const PHONE_RE = /^[6-9]\d{9}$/;
const isValidPhone = phone => PHONE_RE.test(phone);
const INVALID_PHONE_MSG = 'सही 10 अंकों का मोबाइल नंबर डालें।';

// The clinic's day, not the server's. Analytics group by this, and the trend loop
// builds its keys with the same function, so the two always line up.
const TZ = process.env.TZ_NAME || 'Asia/Kolkata';
const dayKey = date => new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date);

// Start-of-period boundary in the clinic's timezone, for the "today / this month /
// this year" filters on the Users and staff tables. Returns null for "all".
const periodStart = period => {
  const [y, m, d] = dayKey(new Date()).split('-');
  if (period === 'today') return new Date(`${y}-${m}-${d}T00:00:00+05:30`);
  if (period === 'week') {
    // Rolling seven days: today plus the six days before it.
    const ago = new Date();
    ago.setDate(ago.getDate() - 6);
    const [wy, wm, wd] = dayKey(ago).split('-');
    return new Date(`${wy}-${wm}-${wd}T00:00:00+05:30`);
  }
  if (period === 'month') return new Date(`${y}-${m}-01T00:00:00+05:30`);
  if (period === 'year') return new Date(`${y}-01-01T00:00:00+05:30`);
  return null;
};

// Shared list handler: filter by created-at period, paginate 20 to a page, and
// return the slice plus the totals the UI needs for its pager and its count.
const paginatedList = async (Model, baseFilter, req) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

  // A custom from/to date range wins over the quick today/month/year period. Dates
  // arrive as YYYY-MM-DD and are read as clinic-timezone day boundaries.
  let createdAt;
  if (req.query.from || req.query.to) {
    createdAt = {};
    if (req.query.from) createdAt.$gte = new Date(`${req.query.from}T00:00:00+05:30`);
    if (req.query.to) createdAt.$lte = new Date(`${req.query.to}T23:59:59.999+05:30`);
  } else {
    const since = periodStart(req.query.period);
    if (since) createdAt = { $gte: since };
  }
  const filter = { ...baseFilter, ...(createdAt && { createdAt }) };
  const [total, items] = await Promise.all([
    Model.countDocuments(filter),
    Model.find(filter).select('-password -pushToken -otpHash -otpExpiry')
      .sort('-createdAt').skip((page - 1) * limit).limit(limit),
  ]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
};

app.get('/api/health', wrap(async (_req, res) =>
  res.json({ ok: true, service: 'heritage-diagnostics-api', orders: await Order.countDocuments() })));

/* ---------------------------------------------------------------- auth ---- */

const issueOtp = async (patient) => {
  const otp = process.env.DEV_OTP || String(crypto.randomInt(1000, 10000));
  patient.otpHash = await hashOtp(otp);
  patient.otpExpiry = new Date(Date.now() + 5 * 60_000);
  patient.otpAttempts = 0;
  await patient.save();

  const { sendSms } = require('./notifications');
  await sendSms(patient.phone, `Heritage Diagnostics OTP: ${otp}`).catch(error =>
    console.error('[otp] sms failed:', error.message));

  // Echoed back outside production so the demo needs no real SMS gateway.
  return process.env.NODE_ENV !== 'production' ? otp : undefined;
};

const patientSession = patient => ({
  token: sign({ id: patient.id, role: 'user' }),
  user: {
    id: patient.id,
    role: 'user',
    name: patient.name,
    phone: patient.phone,
    voiceGuidance: patient.voiceGuidance,
  },
});

// Registration. A phone number alone is not enough — we need somewhere to send the
// agent, so name, city and address are all required, plus a password to log back in.
app.post('/api/auth/register', wrap(async (req, res) => {
  const phone = String(req.body.phone || '').replace(/\D/g, '');
  const name = String(req.body.name || '').trim();
  const village = String(req.body.village || '').trim();
  const address = String(req.body.address || '').trim();
  const password = String(req.body.password || '');

  if (!isValidPhone(phone)) throw fail(400, 'invalid_phone', INVALID_PHONE_MSG);
  if (name.length < 2) throw fail(400, 'name_required', 'अपना पूरा नाम डालें।');
  if (!village) throw fail(400, 'village_required', 'अपना शहर / गाँव डालें।');
  if (address.length < 5) throw fail(400, 'address_required', 'पूरा पता डालें ताकि एजेंट पहुँच सके।');
  if (password.length < 6) throw fail(400, 'weak_password', 'पासवर्ड कम से कम 6 अक्षर का रखें।');

  const existing = await Patient.findOne({ phone });
  if (existing?.password) {
    throw fail(409, 'already_registered', 'यह नंबर पहले से रजिस्टर्ड है। लॉगिन करें।');
  }

  const patient = existing || new Patient({ phone });
  patient.name = name;
  patient.village = village;
  patient.address = address;
  patient.password = await bcrypt.hash(password, 10);
  await patient.save();

  // Straight in — a freshly registered user should not have to log in again.
  res.status(201).json({ registered: true, ...patientSession(patient) });
}));

// Password login. The generic message is deliberate: saying "this number is not
// registered" tells a stranger which of your patients exist.
app.post('/api/auth/login', wrap(async (req, res) => {
  const phone = String(req.body.phone || '').replace(/\D/g, '');
  const password = String(req.body.password || '');
  const wrong = () => fail(401, 'invalid_login', 'मोबाइल नंबर या पासवर्ड गलत है।');

  if (!isValidPhone(phone) || !password) throw wrong();

  const patient = await Patient.findOne({ phone });
  if (!patient?.password) throw wrong();

  if (patient.lockedUntil && patient.lockedUntil > new Date()) {
    throw fail(429, 'too_many_attempts', 'बहुत बार गलत कोशिश। थोड़ी देर बाद फिर से करें।');
  }

  if (!await bcrypt.compare(password, patient.password)) {
    patient.loginAttempts = (patient.loginAttempts || 0) + 1;
    // Ten wrong guesses buys a five-minute lockout — enough to make an offline
    // dictionary run over the network pointless.
    if (patient.loginAttempts >= 10) {
      patient.lockedUntil = new Date(Date.now() + 5 * 60_000);
      patient.loginAttempts = 0;
    }
    await patient.save();
    throw wrong();
  }

  patient.loginAttempts = 0;
  patient.lockedUntil = undefined;
  if (req.body.pushToken) patient.pushToken = req.body.pushToken;
  await patient.save();

  res.json(patientSession(patient));
}));

// Login for an account that already exists. An unknown number is told to register
// rather than being silently created — that is what kept the old build's accounts
// nameless and address-less.
app.post('/api/auth/send-otp', wrap(async (req, res) => {
  const phone = String(req.body.phone || '').replace(/\D/g, '');
  if (!isValidPhone(phone)) throw fail(400, 'invalid_phone', INVALID_PHONE_MSG);

  const patient = await Patient.findOne({ phone });
  if (!patient || !patient.name || patient.name === 'ग्राहक' || !patient.address) {
    throw fail(404, 'not_registered', 'यह नंबर रजिस्टर्ड नहीं है। पहले रजिस्टर करें।');
  }

  const devOtp = await issueOtp(patient);
  res.json({ ok: true, ...(devOtp && { devOtp }) });
}));

app.post('/api/auth/verify-otp', wrap(async (req, res) => {
  const phone = String(req.body.phone || '').replace(/\D/g, '');
  const patient = await Patient.findOne({ phone });
  if (!patient || !patient.otpHash || !patient.otpExpiry || patient.otpExpiry < new Date()) {
    throw fail(400, 'invalid_otp', 'OTP गलत या पुराना है।');
  }
  if (patient.otpAttempts >= 5) throw fail(429, 'too_many_attempts', 'बहुत बार गलत OTP। थोड़ी देर बाद कोशिश करें।');

  if (!await compareOtp(req.body.otp, patient.otpHash)) {
    patient.otpAttempts += 1;
    await patient.save();
    throw fail(400, 'invalid_otp', 'OTP गलत या पुराना है।');
  }

  patient.otpHash = undefined;
  patient.otpExpiry = undefined;
  patient.otpAttempts = 0;
  if (req.body.pushToken) patient.pushToken = req.body.pushToken;
  await patient.save();

  // Kept working for when AUTH_MODE flips back to SMS OTP. role:'user' matches the
  // client's Role union — do not rename without the client.
  res.json(patientSession(patient));
}));

app.post('/api/auth/staff-login', wrap(async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const staff = await Staff.findOne({ username, active: true });
  if (!staff || !await bcrypt.compare(String(req.body.password || ''), staff.password)) {
    throw fail(401, 'invalid_credentials', 'गलत username या password।');
  }
  if (req.body.pushToken) { staff.pushToken = req.body.pushToken; await staff.save(); }
  res.json({
    token: sign({ id: staff.id, role: staff.role }),
    user: { id: staff.id, name: staff.name, role: staff.role, zone: staff.zone },
  });
}));

app.get('/api/auth/me', auth, wrap(async (req, res) => {
  if (req.user.role === 'user') {
    const patient = await Patient.findById(req.user.id).select('-otpHash -otpExpiry');
    if (!patient) throw fail(404, 'not_found', 'खाता नहीं मिला।');
    // phone/village/address feed the app's Profile screen. The phone is the login
    // identity and is never editable from there.
    return res.json({
      id: patient.id, role: 'user', name: patient.name,
      phone: patient.phone, village: patient.village, address: patient.address,
      voiceGuidance: patient.voiceGuidance, createdAt: patient.createdAt,
    });
  }
  const staff = await Staff.findById(req.user.id).select('-password');
  if (!staff || !staff.active) throw fail(404, 'not_found', 'खाता नहीं मिला।');
  res.json({ id: staff.id, role: staff.role, name: staff.name, zone: staff.zone });
}));

/* ------------------------------------------------------- patient orders ---- */

// Up to six pages of a prescription. `any()` rather than a fixed field name so both
// shapes work: the new app sends several files as `prescriptions`, older builds send
// exactly one as `prescription`.
app.post('/api/orders', auth, allow('user'), upload.any(), wrap(async (req, res) => {
  const files = (req.files || []).filter(f => ['prescription', 'prescriptions'].includes(f.fieldname)).slice(0, 6);
  if (!files.length) throw fail(400, 'prescription_required', 'पर्ची की फोटो ज़रूरी है।');
  const urls = files.map(f => `/uploads/${f.filename}`);

  const tests = Array.isArray(req.body.tests) ? req.body.tests : (req.body.tests ? [req.body.tests] : []);
  const order = await Order.create({
    patient: req.user.id,
    // First image stays in prescriptionUrl so anything that only knows about a
    // single photo (old app builds, old orders) keeps working.
    prescriptionUrl: urls[0],
    prescriptionUrls: urls,
    tests,
    village: req.body.village,
    address: req.body.address,
    status: STATUS.SUBMITTED,
  });

  await OrderStatusHistory.create({ order: order._id, status: STATUS.SUBMITTED });

  // Wake the PRO desk — a prescription nobody calls about is the whole failure mode.
  const pros = await Staff.find({ role: 'pro', active: true });
  await Promise.all(pros.map(pro =>
    notifyStaff(pro, order, {
      hi: `नई पर्ची आई है: ${order.orderId}`,
      en: `New prescription: ${order.orderId}`,
    }, 'new_order')));

  const created = await populateOrder(Order.findById(order._id));
  emitOrderCreated(created);          // the PRO's list lights up immediately
  res.status(201).json(created);
}));

app.get('/api/orders/my', auth, allow('user'), wrap(async (req, res) =>
  res.json(await populateOrder(Order.find({ patient: req.user.id }).sort('-createdAt')))));

app.get('/api/orders/my/latest', auth, allow('user'), wrap(async (req, res) => {
  const order = await populateOrder(Order.findOne({ patient: req.user.id }).sort('-createdAt'));
  // Bare null when there is no order. The client does `latest ? latest.order.orderId : …`,
  // so returning {order: null} here would be truthy and crash the Status screen.
  if (!order) return res.json(null);
  const history = await OrderStatusHistory.find({ order: order._id }).sort('timestamp');
  res.json({ order, stepIndex: stepIndex(order.status), steps: STEPS, history });
}));

app.get('/api/orders/:id/status-history', auth, wrap(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) throw fail(404, 'not_found', 'ऑर्डर नहीं मिला।');
  if (req.user.role === 'user' && String(order.patient) !== req.user.id) {
    throw fail(403, 'forbidden', 'आपके पास अनुमति नहीं है।');
  }
  if (req.user.role === 'lab' && !QUEUES.lab.includes(order.status)) {
    throw fail(403, 'forbidden', 'यह ऑर्डर LAB queue में नहीं है।');
  }
  const history = await OrderStatusHistory.find({ order: order._id })
    .populate('changedByStaff', 'name role')
    .sort('timestamp');
  res.json({ orderId: order.orderId, status: order.status, stepIndex: stepIndex(order.status), steps: STEPS, history });
}));

/* --------------------------------------------------------- staff orders ---- */

app.get('/api/orders', auth, allow('pro', 'agent', 'lab', 'admin'), wrap(async (req, res) => {
  const query = {};

  // A LAB token is always pinned to the LAB queue. Supplying a different `status`
  // query must not turn this endpoint into a way to browse every order.
  if (req.user.role === 'lab') {
    query.status = { $in: QUEUES.lab };
  } else if (req.query.status) {
    const requested = String(req.query.status).split(',').filter(s => ALL_STATUSES.includes(s));
    if (requested.length) query.status = { $in: requested };
  } else if (QUEUES[req.user.role]) {
    query.status = { $in: QUEUES[req.user.role] };
  }

  // An agent may only ever see their own pickups, whatever they ask for.
  if (req.user.role === 'agent') query.assignedAgent = req.user.id;
  else if (req.query.assignedAgent === 'me') query.assignedAgent = req.user.id;
  else if (req.query.assignedAgent) query.assignedAgent = req.query.assignedAgent;

  if (req.query.date === 'today') {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    query.createdAt = { $gte: start };
  }

  const orders = await populateOrder(Order.find(query).sort('-createdAt').limit(Number(req.query.limit) || 100));
  res.json(req.user.role === 'lab' ? orders.map(labOrderView) : orders);
}));

// Completed work stays available to the account that handled it. This is a
// separate endpoint from the live queue so refreshing or signing out can never
// make finished work appear deleted, while one staff member still cannot browse
// another staff member's history.
app.get('/api/orders/history', auth, allow('pro', 'agent', 'lab', 'admin'), wrap(async (req, res) => {
  const query = {};

  if (req.user.role === 'pro') {
    query.pro = req.user.id;
    query.status = { $in: [
      STATUS.AGENT_ASSIGNED, STATUS.SAMPLE_COLLECTED, STATUS.LAB_RECEIVED,
      STATUS.REPORT_READY, STATUS.CANCELLED,
    ] };
  } else if (req.user.role === 'agent') {
    query.assignedAgent = req.user.id;
    query.status = { $in: [
      STATUS.SAMPLE_COLLECTED, STATUS.LAB_RECEIVED, STATUS.REPORT_READY, STATUS.CANCELLED,
    ] };
  } else if (req.user.role === 'lab') {
    const handledOrderIds = await OrderStatusHistory.distinct('order', {
      changedByStaff: req.user.id,
      status: { $in: [STATUS.LAB_RECEIVED, STATUS.REPORT_READY] },
    });
    query._id = { $in: handledOrderIds };
    query.status = { $in: [STATUS.REPORT_READY, STATUS.CANCELLED] };
  } else {
    query.status = { $in: [STATUS.REPORT_READY, STATUS.CANCELLED] };
  }

  const orders = await populateOrder(Order.find(query).sort('-updatedAt').limit(100));
  res.json(req.user.role === 'lab' ? orders.map(labOrderView) : orders);
}));

app.get('/api/orders/:id', auth, allow('pro', 'agent', 'lab', 'admin'), wrap(async (req, res) => {
  const order = await populateOrder(Order.findById(req.params.id));
  if (!order) throw fail(404, 'not_found', 'ऑर्डर नहीं मिला।');
  if (req.user.role === 'agent' && String(order.assignedAgent?._id) !== req.user.id) {
    throw fail(403, 'forbidden', 'यह pickup आपका नहीं है।');
  }
  if (req.user.role === 'lab' && !QUEUES.lab.includes(order.status)) {
    throw fail(403, 'forbidden', 'यह ऑर्डर LAB queue में नहीं है।');
  }
  res.json(req.user.role === 'lab' ? labOrderView(order) : order);
}));

app.get('/api/staff/agents', auth, allow('pro', 'admin'), wrap(async (req, res) => {
  // Every active agent, whatever their zone. Who goes out is the PRO's call — they
  // know the round, the traffic and who is nearby — so the server's job is only to
  // say who is free, not to pre-filter by a zone label. Zone filtering used to hide
  // the whole roster whenever a village was typed with different capitalisation
  // from the agent's zone, which is exactly the wrong failure for a dispatch screen.
  const agents = await Staff.find({ role: 'agent', active: true })
    .select('-password -pushToken').lean();

  // An agent is BUSY while they are carrying an order: from the moment one is
  // assigned to them until the lab has the sample in hand. A busy agent is not
  // offered for a new pickup — they are physically out on the last one.
  const loads = await Order.aggregate([
    { $match: { status: { $in: [STATUS.AGENT_ASSIGNED, STATUS.SAMPLE_COLLECTED] } } },
    {
      $group: {
        _id: '$assignedAgent',
        count: { $sum: 1 },
        orders: { $push: '$orderId' },
      },
    },
  ]);
  const loadByAgent = Object.fromEntries(loads.map(l => [String(l._id), l]));

  // Free agents first, then the least-loaded — the PRO's first option should be
  // someone who can actually go.
  res.json(agents
    .map(agent => {
      const load = loadByAgent[String(agent._id)];
      const currentLoad = load?.count || 0;
      return {
        ...agent,
        currentLoad,
        busy: currentLoad > 0,
        busyWith: load?.orders || [],
      };
    })
    .sort((a, b) => a.currentLoad - b.currentLoad));
}));

/* -------------------------------------------------------------- actions ---- */
// Each action is a guard + a transition. Statuses are never written directly.

const loadOrder = wrap(async (req, _res, next) => {
  const order = await Order.findById(req.params.id);
  if (!order) throw fail(404, 'not_found', 'ऑर्डर नहीं मिला।');
  req.order = order;
  next();
});

const ownPickup = (req) => {
  if (String(req.order.assignedAgent) !== req.user.id) {
    throw fail(403, 'forbidden', 'यह pickup आपका नहीं है।');
  }
};

const action = (roles, handler) => [auth, allow(...roles), loadOrder, wrap(handler)];

// PRO calls the patient. Moves submitted -> pro_review.
app.patch('/api/orders/:id/pro-call', ...action(['pro', 'admin'], async (req, res) => {
  const order = await moveTo(req.order, STATUS.PRO_REVIEW, {
    staffId: req.user.id,
    note: 'PRO ने मरीज़ को कॉल किया',
    mutate: o => { o.proCalled = true; o.pro = req.user.id; },
  });
  res.json(order);
}));

// PRO confirms tests + amount. Requires the call to have happened.
app.patch('/api/orders/:id/pro-confirm', ...action(['pro', 'admin'], async (req, res) => {
  if (!req.order.proCalled) throw fail(400, 'call_required', 'पहले मरीज़ को कॉल करें।');

  // Preferred path: the PRO sends catalog test IDs and the server prices them
  // itself, so the amount can never be typed or tampered with. `otherTests` is the
  // manual fallback for a test that isn't in the catalog.
  let testItems = [];
  let legacyAmount = null;

  if (Array.isArray(req.body.testIds) && req.body.testIds.length) {
    const ids = req.body.testIds.filter(id => /^[a-f0-9]{24}$/i.test(String(id)));
    const found = await TestCatalog.find({ _id: { $in: ids }, isActive: true });
    testItems = found.map(c => ({ name: c.name, amount: c.amount }));
  }
  if (Array.isArray(req.body.otherTests)) {
    for (const o of req.body.otherTests) {
      const name = String(o?.name || '').trim();
      const amt = Number(o?.amount);
      if (name && Number.isFinite(amt) && amt >= 0) testItems.push({ name, amount: amt });
    }
  }

  // Legacy path: an older app build still sends {tests:[names], amount}. Honour it
  // so a not-yet-updated phone keeps working.
  if (!testItems.length && Array.isArray(req.body.tests)) {
    const names = req.body.tests.map(t => String(t).trim()).filter(Boolean);
    const amount = Number(req.body.amount);
    if (names.length && Number.isFinite(amount) && amount >= 0) {
      testItems = names.map(n => ({ name: n, amount: 0 }));
      legacyAmount = amount;
    }
  }

  if (!testItems.length) throw fail(400, 'tests_required', 'कम से कम एक जांच चुनें।');

  const names = testItems.map(t => t.name);
  const amount = legacyAmount != null
    ? legacyAmount
    : testItems.reduce((sum, t) => sum + (t.amount || 0), 0);

  const order = await moveTo(req.order, STATUS.CONFIRMED, {
    staffId: req.user.id,
    note: `जांच confirm: ${names.join(', ')} · ₹${amount}`,
    mutate: o => {
      o.tests = names;
      o.testItems = testItems.map(t => ({ name: t.name, amount: t.amount || 0 }));
      o.amount = amount;
      o.paymentMode = req.body.paymentMode === 'online' ? 'online' : 'cash';
      o.proConfirmed = true;
      o.pro = req.user.id;
    },
  });
  res.json(order);
}));

app.patch('/api/orders/:id/assign-agent', ...action(['pro', 'admin'], async (req, res) => {
  const agent = await Staff.findOne({ _id: req.body.agentId, role: 'agent', active: true });
  if (!agent) throw fail(400, 'invalid_agent', 'यह एजेंट उपलब्ध नहीं है।');
  if (!req.body.pickupSlot) throw fail(400, 'slot_required', 'Pickup समय चुनें।');

  // An agent already out on a pickup cannot be sent on another. The UI hides them,
  // but the rule belongs here — a stale screen must not be able to double-book.
  const busy = await Order.countDocuments({
    assignedAgent: agent._id,
    status: { $in: [STATUS.AGENT_ASSIGNED, STATUS.SAMPLE_COLLECTED] },
  });
  if (busy > 0) {
    throw fail(409, 'agent_busy', `${agent.name} अभी दूसरे pickup पर हैं। कोई खाली एजेंट चुनें।`);
  }

  const order = await moveTo(req.order, STATUS.AGENT_ASSIGNED, {
    staffId: req.user.id,
    note: `एजेंट: ${agent.name} · ${req.body.pickupSlot}`,
    mutate: o => { o.assignedAgent = agent._id; o.pickupSlot = req.body.pickupSlot; },
  });

  await notifyStaff(agent, order, {
    hi: `नया pickup: ${order.orderId} · ${order.pickupSlot}`,
    en: `New pickup: ${order.orderId} · ${order.pickupSlot}`,
  }, 'pickup_assigned');
  res.json(order);
}));

// The two checkboxes. Idempotent set (not a toggle) so an offline replay is safe,
// and locked once the order has left the agent's hands.
const checklist = field => async (req, res) => {
  ownPickup(req);
  if (req.order.status !== STATUS.AGENT_ASSIGNED) {
    throw fail(409, 'not_editable', 'यह ऑर्डर अब बदला नहीं जा सकता।');
  }
  req.order[field] = req.body.value === undefined ? true : Boolean(req.body.value);
  if (field === 'cashTaken') req.order.paymentCollected = req.order.cashTaken;
  await req.order.save();

  // The checkboxes do not change status, so they bypass moveTo() — emit here or
  // the admin would not see "sample taken" tick until the agent completes.
  const updated = await populateOrder(Order.findById(req.order._id));
  emitOrderUpdated(updated);
  res.json(updated);
};

app.patch('/api/orders/:id/sample-taken', ...action(['agent'], checklist('sampleTaken')));
app.patch('/api/orders/:id/cash-taken', ...action(['agent'], checklist('cashTaken')));

app.patch('/api/orders/:id/agent-complete', ...action(['agent'], async (req, res) => {
  ownPickup(req);
  if (!req.order.sampleTaken) throw fail(400, 'sample_required', 'पहले sample लेना ज़रूरी है।');

  // Some clients legitimately send no JSON body here (the order already carries
  // the default payment mode). Express leaves req.body undefined in that case;
  // reading paymentMode from it used to throw a 500 and strand completed work.
  const body = req.body || {};

  // The agent chose how the patient paid — cash in hand or already online. Trust
  // that over whatever the order defaulted to, and only demand cash-in-hand when
  // the agent actually marked it cash.
  const paymentMode = ['cash', 'online'].includes(body.paymentMode)
    ? body.paymentMode
    : req.order.paymentMode;
  if (paymentMode === 'cash' && !req.order.cashTaken) {
    throw fail(400, 'cash_required', 'पहले cash लेना ज़रूरी है।');
  }

  const order = await moveTo(req.order, STATUS.SAMPLE_COLLECTED, {
    staffId: req.user.id,
    note: 'एजेंट ने sample लिया',
    mutate: o => {
      o.labTube = ['EDTA', 'SST', 'FLU'].includes(body.labTube) ? body.labTube : 'EDTA';
      o.paymentMode = paymentMode;
      // Online orders are paid the moment they're placed; cash is collected on the
      // doorstep and tracked by the cashTaken checkbox.
      o.paymentCollected = paymentMode === 'online' ? true : o.cashTaken;
    },
  });

  const labs = await Staff.find({ role: 'lab', active: true });
  await Promise.all(labs.map(lab =>
    notifyStaff(lab, order, {
      hi: `Sample आ रहा है: ${order.orderId} (${order.labTube})`,
      en: `Sample incoming: ${order.orderId} (${order.labTube})`,
    }, 'sample_inbound')));

  res.json(order);
}));

app.patch('/api/orders/:id/lab-confirm', ...action(['lab', 'admin'], async (req, res) => {
  const order = await moveTo(req.order, STATUS.LAB_RECEIVED, {
    staffId: req.user.id,
    note: 'लैब को sample मिला',
    mutate: o => { o.labReceivedAt = new Date(); },
  });
  res.json(req.user.role === 'lab' ? labOrderView(order) : order);
}));

// Report upload. Takes a real file — the old endpoint accepted any client-supplied
// URL string, which meant a lab user could point a patient's report anywhere.
app.post('/api/orders/:id/upload-report',
  auth, allow('lab', 'admin'), upload.single('report'), loadOrder,
  wrap(async (req, res) => {
    if (!req.file) throw fail(400, 'report_required', 'रिपोर्ट फाइल ज़रूरी है।');
    const order = await moveTo(req.order, STATUS.REPORT_READY, {
      staffId: req.user.id,
      note: 'रिपोर्ट अपलोड हुई',
      mutate: o => { o.reportUrl = `/uploads/${req.file.filename}`; },
    });
    res.json(req.user.role === 'lab' ? labOrderView(order) : order);
  }));

app.patch('/api/orders/:id/cancel', ...action(['pro', 'admin'], async (req, res) => {
  const order = await moveTo(req.order, STATUS.CANCELLED, {
    staffId: req.user.id,
    note: req.body.reason || 'रद्द',
    mutate: o => { o.cancelReason = req.body.reason; },
  });
  res.json(order);
}));

/* ------------------------------------------------------- notifications ---- */

const notificationsFor = req =>
  (req.user.role === 'user' ? { patient: req.user.id } : { staff: req.user.id });

// The bell is a live feed, not an archive. By default it returns only what the
// reader has not seen yet — a dashboard left open all day was showing thirty-odd
// items, so the one that had just arrived was buried.
// ?all=1 returns the recent history.
app.get('/api/notifications', auth, wrap(async (req, res) => {
  const filter = notificationsFor(req);
  if (req.query.all !== '1') filter.read = false;

  res.json(await Notification.find(filter)
    .sort('-createdAt')
    .limit(req.query.all === '1' ? 50 : 20));
}));

app.patch('/api/notifications/read-all', auth, wrap(async (req, res) => {
  const { modifiedCount } = await Notification.updateMany(
    { ...notificationsFor(req), read: false },
    { read: true },
  );
  res.json({ ok: true, cleared: modifiedCount });
}));

app.patch('/api/notifications/:id/read', auth, wrap(async (req, res) => {
  const filter = req.user.role === 'user' ? { patient: req.user.id } : { staff: req.user.id };
  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.id, ...filter }, { read: true }, { new: true });
  if (!notification) throw fail(404, 'not_found', 'नहीं मिला।');
  res.json(notification);
}));

app.patch('/api/me/settings', auth, allow('user'), wrap(async (req, res) => {
  const patient = await Patient.findById(req.user.id);
  if (!patient) throw fail(404, 'not_found', 'खाता नहीं मिला।');
  if (req.body.voiceGuidance !== undefined) patient.voiceGuidance = Boolean(req.body.voiceGuidance);
  if (req.body.name) patient.name = String(req.body.name).trim();
  if (req.body.village !== undefined) patient.village = req.body.village;
  if (req.body.address !== undefined) patient.address = req.body.address;
  if (req.body.pushToken) patient.pushToken = req.body.pushToken;
  await patient.save();
  res.json({ id: patient.id, name: patient.name, voiceGuidance: patient.voiceGuidance });
}));

// Set a new password from inside the app. Deliberately separate from /me/settings
// so a password can never ride along on a profile edit.
//
// The current password is NOT required: the caller already holds a valid session
// token for this account, which is the same proof a login would give. That is the
// point — a patient who has forgotten their password but is still signed in can fix
// it themselves instead of being locked out. Signing out everywhere is the trade we
// accept for that; the token stays valid, so they are not kicked out mid-change.
app.patch('/api/me/password', auth, allow('user'), wrap(async (req, res) => {
  const password = String(req.body.password || '');
  if (password.length < 6) throw fail(400, 'weak_password', 'पासवर्ड कम से कम 6 अक्षर का रखें।');

  const patient = await Patient.findById(req.user.id);
  if (!patient) throw fail(404, 'not_found', 'खाता नहीं मिला।');

  patient.password = await bcrypt.hash(password, 10);
  patient.loginAttempts = 0;
  patient.lockedUntil = undefined;
  await patient.save();

  res.json({ ok: true });
}));

/* --------------------------------------------------------------- admin ---- */

app.get('/api/admin/stats/today', auth, allow('admin'), wrap(async (req, res) => {
  const start = new Date(); start.setHours(0, 0, 0, 0);

  const [byStatus, cash] = await Promise.all([
    Order.aggregate([
      { $match: { createdAt: { $gte: start } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Order.aggregate([
      { $match: { cashTaken: true, updatedAt: { $gte: start } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
  ]);

  const counts = Object.fromEntries(byStatus.map(row => [row._id, row.count]));
  res.json({
    newPrescriptions: counts[STATUS.SUBMITTED] || 0,
    confirmed: counts[STATUS.CONFIRMED] || 0,
    inLab: (counts[STATUS.SAMPLE_COLLECTED] || 0) + (counts[STATUS.LAB_RECEIVED] || 0),
    reportsReady: counts[STATUS.REPORT_READY] || 0,
    cashCollected: cash[0]?.total || 0,
    byStatus: counts,
  });
}));

// Everything the dashboard's charts need, in one round trip.
app.get('/api/admin/stats/overview', auth, allow('admin'), wrap(async (req, res) => {
  const days = Math.min(60, Math.max(7, Number(req.query.days) || 14));
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - (days - 1));

  const [daily, byStatus, byAgent, revenue] = await Promise.all([
    Order.aggregate([
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          // Group in the clinic's timezone, not UTC. Varanasi is +05:30, so a UTC
          // bucket puts everything before 05:30 IST on the previous day — and the
          // day keys then never match the ones the loop below builds locally,
          // which silently produces an all-zero trend line.
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: TZ } },
          orders: { $sum: 1 },
          revenue: { $sum: '$amount' },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Order.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Order.aggregate([
      { $match: { assignedAgent: { $ne: null } } },
      {
        $group: {
          _id: '$assignedAgent',
          pickups: { $sum: 1 },
          collected: { $sum: { $cond: ['$cashTaken', '$amount', 0] } },
        },
      },
      { $lookup: { from: 'staffs', localField: '_id', foreignField: '_id', as: 'agent' } },
      { $unwind: '$agent' },
      {
        $project: {
          _id: 0, name: '$agent.name', zone: '$agent.zone', pickups: 1, collected: 1,
        },
      },
      { $sort: { collected: -1 } },
    ]),
    Order.aggregate([
      { $match: { cashTaken: true } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
  ]);

  // Fill the gaps: a day with no orders must still appear on the trend line,
  // otherwise the x-axis silently compresses and the shape lies.
  const counts = Object.fromEntries(daily.map(row => [row._id, row]));
  const trend = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(since);
    day.setDate(since.getDate() + i);
    const key = dayKey(day);
    trend.push({
      date: key,
      orders: counts[key]?.orders || 0,
      revenue: counts[key]?.revenue || 0,
    });
  }

  res.json({
    days,
    trend,
    byStatus: Object.fromEntries(byStatus.map(row => [row._id, row.count])),
    byAgent,
    totalOrders: await Order.countDocuments(),
    totalRevenue: revenue[0]?.total || 0,
  });
}));

app.get('/api/admin/orders', auth, allow('admin'), wrap(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 20);

  const query = {};
  if (req.query.status && ALL_STATUSES.includes(req.query.status)) query.status = req.query.status;
  if (req.query.agent) query.assignedAgent = req.query.agent;
  if (req.query.from || req.query.to) {
    query.createdAt = {
      ...(req.query.from && { $gte: new Date(req.query.from) }),
      ...(req.query.to && { $lte: new Date(req.query.to) }),
    };
  }

  const [rows, total] = await Promise.all([
    populateOrder(Order.find(query).sort('-createdAt').skip((page - 1) * limit).limit(limit)),
    Order.countDocuments(query),
  ]);
  res.json({ rows, total, page, pages: Math.ceil(total / limit) });
}));

app.get('/api/admin/staff', auth, allow('admin'), wrap(async (req, res) => {
  // Paginated + date-filtered when a page/period is asked for; otherwise the plain
  // full list (the assign flows and availability checks still expect an array).
  if (req.query.page || req.query.period) {
    return res.json(await paginatedList(Staff, req.query.role ? { role: req.query.role } : {}, req));
  }
  const filter = req.query.role ? { role: req.query.role } : {};
  res.json(await Staff.find(filter).select('-password -pushToken').sort('role name'));
}));

// Staff accounts are created BY THE ADMIN, never self-registered. If the app let
// anyone sign up as a PRO or an agent, anyone who installed the APK could read
// every patient's name, phone, address and report.
app.post('/api/admin/staff', auth, allow('admin'), wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const username = String(req.body.username || '').trim().toLowerCase();
  const role = String(req.body.role || '');
  const password = String(req.body.password || '');
  const phone = String(req.body.phone || '').replace(/\D/g, '');

  if (name.length < 2) throw fail(400, 'name_required', 'नाम डालें।');
  if (!/^[a-z0-9._-]{3,}$/.test(username)) {
    throw fail(400, 'invalid_username', 'Username कम से कम 3 अक्षर (a-z, 0-9) का हो।');
  }
  if (!['pro', 'agent', 'lab', 'admin'].includes(role)) {
    throw fail(400, 'invalid_role', 'Role चुनें।');
  }
  if (password.length < 6) throw fail(400, 'weak_password', 'पासवर्ड कम से कम 6 अक्षर का रखें।');
  // The UI caps the field at ten digits; the server enforces it, because a staff
  // phone is what the SMS gateway will actually dial.
  if (!isValidPhone(phone)) throw fail(400, 'invalid_phone', INVALID_PHONE_MSG);

  if (await Staff.findOne({ username })) {
    throw fail(409, 'username_taken', 'यह username पहले से मौजूद है।');
  }

  const staff = await Staff.create({
    name, username, role, phone,
    zone: req.body.zone || 'All',
    password: await bcrypt.hash(password, 10),
    active: true,
  });

  res.status(201).json({
    _id: staff._id, name: staff.name, username: staff.username,
    role: staff.role, zone: staff.zone, phone: staff.phone, active: staff.active,
  });
}));

// Deactivate rather than delete: an agent's name still has to render on the orders
// they already collected.
app.patch('/api/admin/staff/:id', auth, allow('admin'), wrap(async (req, res) => {
  const staff = await Staff.findById(req.params.id);
  if (!staff) throw fail(404, 'not_found', 'स्टाफ नहीं मिला।');

  if (req.body.active !== undefined) staff.active = Boolean(req.body.active);
  if (req.body.name) staff.name = String(req.body.name).trim();
  if (req.body.zone) staff.zone = String(req.body.zone).trim();
  if (req.body.phone) {
    const phone = String(req.body.phone).replace(/\D/g, '');
    if (!isValidPhone(phone)) throw fail(400, 'invalid_phone', INVALID_PHONE_MSG);
    staff.phone = phone;
  }
  if (req.body.password) {
    if (String(req.body.password).length < 6) {
      throw fail(400, 'weak_password', 'पासवर्ड कम से कम 6 अक्षर का रखें।');
    }
    staff.password = await bcrypt.hash(String(req.body.password), 10);
  }

  await staff.save();
  res.json({
    _id: staff._id, name: staff.name, username: staff.username,
    role: staff.role, zone: staff.zone, phone: staff.phone, active: staff.active,
  });
}));

// Delete a staff account outright. Refused while they are mid-job — an agent
// holding a sample, a lab with one on the bench — because removing them would
// strand that order with nobody to finish it. Disable is still the gentler option:
// it keeps their name on the orders they already handled.
app.delete('/api/admin/staff/:id', auth, allow('admin'), wrap(async (req, res) => {
  const staff = await Staff.findById(req.params.id);
  if (!staff) throw fail(404, 'not_found', 'स्टाफ नहीं मिला।');
  if (staff.role === 'admin') throw fail(400, 'cannot_delete_admin', 'एडमिन खाता नहीं हटाया जा सकता।');

  const inFlight = await Order.countDocuments({
    $or: [{ assignedAgent: staff._id }, { pro: staff._id }],
    status: { $in: [STATUS.AGENT_ASSIGNED, STATUS.SAMPLE_COLLECTED, STATUS.LAB_RECEIVED] },
  });
  if (inFlight > 0) {
    throw fail(409, 'staff_busy', `${staff.name} अभी ${inFlight} ऑर्डर पर काम कर रहे हैं। पहले वो पूरे करें, या खाता बंद (disable) करें।`);
  }

  await Staff.deleteOne({ _id: staff._id });
  res.json({ deleted: true });
}));

app.get('/api/admin/patients', auth, allow('admin'), wrap(async (req, res) =>
  res.json(await paginatedList(Patient, {}, req))));

// Remove a patient for good, along with everything that hangs off them — their
// orders, those orders' history, and their notifications. Nothing is left behind
// pointing at a patient that no longer exists. The dashboard warns how many orders
// go with them before this is called.
app.delete('/api/admin/patients/:id', auth, allow('admin'), wrap(async (req, res) => {
  const patient = await Patient.findById(req.params.id);
  if (!patient) throw fail(404, 'not_found', 'मरीज़ नहीं मिला।');

  const orders = await Order.find({ patient: patient._id }).select('_id');
  const orderIds = orders.map(o => o._id);
  await Promise.all([
    OrderStatusHistory.deleteMany({ order: { $in: orderIds } }),
    Notification.deleteMany({ patient: patient._id }),
    Order.deleteMany({ patient: patient._id }),
  ]);
  await Patient.deleteOne({ _id: patient._id });

  res.json({ deleted: true, orders: orderIds.length });
}));

/* -------------------------------------------------------- test catalog ---- */

// The PRO's app reads the live price list; the admin manages it. Active-only for
// everyone except the admin, who asks for ?all=1 to see disabled tests too.
app.get('/api/test-catalog', auth, allow('pro', 'lab', 'admin'), wrap(async (req, res) => {
  const showAll = req.user.role === 'admin' && req.query.all;
  const filter = showAll ? {} : { isActive: true };
  const tests = await TestCatalog.find(filter).sort('category name');
  // LAB only needs the reference names/categories. Rates and management fields
  // remain an Admin/PRO concern and are omitted at the API boundary.
  if (req.user.role === 'lab') {
    return res.json(tests.map(test => ({
      _id: test._id,
      name: test.name,
      category: test.category,
    })));
  }
  res.json(tests);
}));

const createCatalogTest = async (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim();
  const amount = Number(body.amount);
  if (name.length < 2) throw fail(400, 'name_required', 'जांच का नाम डालें।');
  if (!Number.isFinite(amount) || amount < 0) throw fail(400, 'invalid_amount', 'सही रेट डालें।');
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (await TestCatalog.exists({ name: { $regex: `^${escapedName}$`, $options: 'i' } })) {
    throw fail(409, 'test_exists', 'यह जांच पहले से catalog में है।');
  }
  const test = await TestCatalog.create({ name, category: String(body.category || '').trim(), amount });
  res.status(201).json(req.user.role === 'lab'
    ? { _id: test._id, name: test.name, category: test.category }
    : test);
};

// LAB may add a priced test, but cannot edit, disable or delete existing items.
app.post('/api/test-catalog', auth, allow('lab'), wrap(createCatalogTest));
app.post('/api/admin/test-catalog', auth, allow('admin'), wrap(createCatalogTest));

app.patch('/api/admin/test-catalog/:id', auth, allow('admin'), wrap(async (req, res) => {
  const test = await TestCatalog.findById(req.params.id);
  if (!test) throw fail(404, 'not_found', 'जांच नहीं मिली।');
  if (req.body.name !== undefined) test.name = String(req.body.name).trim();
  if (req.body.category !== undefined) test.category = String(req.body.category).trim();
  if (req.body.amount !== undefined) {
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount < 0) throw fail(400, 'invalid_amount', 'सही रेट डालें।');
    test.amount = amount;
  }
  if (req.body.isActive !== undefined) test.isActive = Boolean(req.body.isActive);
  await test.save();
  res.json(test);
}));

// Soft delete — disable, never remove, so old orders that referenced it stay whole.
app.delete('/api/admin/test-catalog/:id', auth, allow('admin'), wrap(async (req, res) => {
  const test = await TestCatalog.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
  if (!test) throw fail(404, 'not_found', 'जांच नहीं मिली।');
  res.json(test);
}));

/* --------------------------------------------------------------- errors ---- */

// The client reads `message` (client.ts:21) and shows it to the user verbatim,
// so every error carries human Hindi text. 500s never leak internals.
app.use((err, _req, res, _next) => {
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({
    code: err.code || 'server_error',
    message: status >= 500
      ? 'सर्वर में कुछ गड़बड़ है। थोड़ी देर बाद कोशिश करें।'
      : (err.message || 'अनुरोध पूरा नहीं हो सका।'),
  });
});

module.exports = app;
