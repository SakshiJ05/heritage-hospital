const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcryptjs');

const { Patient, Staff, Order, OrderStatusHistory, Notification } = require('./models');
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
  const staff = await Staff.findOne({ username: String(req.body.username || '').trim(), active: true });
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
    return res.json({ id: patient.id, role: 'user', name: patient.name, voiceGuidance: patient.voiceGuidance });
  }
  const staff = await Staff.findById(req.user.id).select('-password');
  if (!staff || !staff.active) throw fail(404, 'not_found', 'खाता नहीं मिला।');
  res.json({ id: staff.id, role: staff.role, name: staff.name, zone: staff.zone });
}));

/* ------------------------------------------------------- patient orders ---- */

app.post('/api/orders', auth, allow('user'), upload.single('prescription'), wrap(async (req, res) => {
  if (!req.file) throw fail(400, 'prescription_required', 'पर्ची की फोटो ज़रूरी है।');

  const tests = Array.isArray(req.body.tests) ? req.body.tests : (req.body.tests ? [req.body.tests] : []);
  const order = await Order.create({
    patient: req.user.id,
    prescriptionUrl: `/uploads/${req.file.filename}`,
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
  const history = await OrderStatusHistory.find({ order: order._id })
    .populate('changedByStaff', 'name role')
    .sort('timestamp');
  res.json({ orderId: order.orderId, status: order.status, stepIndex: stepIndex(order.status), steps: STEPS, history });
}));

/* --------------------------------------------------------- staff orders ---- */

app.get('/api/orders', auth, allow('pro', 'agent', 'lab', 'admin'), wrap(async (req, res) => {
  const query = {};

  if (req.query.status) {
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

  res.json(await populateOrder(Order.find(query).sort('-createdAt').limit(Number(req.query.limit) || 100)));
}));

app.get('/api/orders/:id', auth, allow('pro', 'agent', 'lab', 'admin'), wrap(async (req, res) => {
  const order = await populateOrder(Order.findById(req.params.id));
  if (!order) throw fail(404, 'not_found', 'ऑर्डर नहीं मिला।');
  if (req.user.role === 'agent' && String(order.assignedAgent?._id) !== req.user.id) {
    throw fail(403, 'forbidden', 'यह pickup आपका नहीं है।');
  }
  res.json(order);
}));

app.get('/api/staff/agents', auth, allow('pro', 'admin'), wrap(async (req, res) => {
  // Match agents in the patient's zone, plus anyone whose zone is 'All' — a
  // small operation often runs one or two agents who cover the whole city, and an
  // exact-zone-only filter would hide them for every village but the one they were
  // labelled with, leaving the PRO staring at "no agents".
  const filter = { role: 'agent', active: true };
  if (req.query.zone) filter.$or = [{ zone: req.query.zone }, { zone: 'All' }];
  const agents = await Staff.find(filter).select('-password -pushToken').lean();

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

  const tests = (Array.isArray(req.body.tests) ? req.body.tests : [])
    .map(t => String(t).trim()).filter(Boolean);
  if (!tests.length) throw fail(400, 'tests_required', 'कम से कम एक जांच चुनें।');

  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount < 0) throw fail(400, 'invalid_amount', 'राशि सही नहीं है।');

  const order = await moveTo(req.order, STATUS.CONFIRMED, {
    staffId: req.user.id,
    note: `जांच confirm: ${tests.join(', ')} · ₹${amount}`,
    mutate: o => {
      o.tests = tests;
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

  // The agent chose how the patient paid — cash in hand or already online. Trust
  // that over whatever the order defaulted to, and only demand cash-in-hand when
  // the agent actually marked it cash.
  const paymentMode = ['cash', 'online'].includes(req.body.paymentMode)
    ? req.body.paymentMode
    : req.order.paymentMode;
  if (paymentMode === 'cash' && !req.order.cashTaken) {
    throw fail(400, 'cash_required', 'पहले cash लेना ज़रूरी है।');
  }

  const order = await moveTo(req.order, STATUS.SAMPLE_COLLECTED, {
    staffId: req.user.id,
    note: 'एजेंट ने sample लिया',
    mutate: o => {
      o.labTube = ['EDTA', 'SST', 'FLU'].includes(req.body.labTube) ? req.body.labTube : 'EDTA';
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
  res.json(order);
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
    res.json(order);
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

app.get('/api/admin/patients', auth, allow('admin'), wrap(async (_req, res) =>
  res.json(await Patient.find().select('-otpHash -otpExpiry -pushToken').sort('-createdAt').limit(200))));

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
