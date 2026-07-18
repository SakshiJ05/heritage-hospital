// Full-pipeline integration test: patient -> PRO -> agent -> lab, plus the
// authorization and illegal-transition guards. Runs against an in-memory MongoDB,
// so it needs no local mongod.

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.JWT_SECRET = 'test-secret-that-is-long-enough';
process.env.DEV_OTP = '1234';
process.env.NODE_ENV = 'test';

const app = require('../src/app');
const { Patient, Staff, Order } = require('../src/models');
const { STATUS } = require('../src/status');

let mongod;
let server;
let base;

const api = async (method, path, { token, body, form } = {}) => {
  const headers = { ...(token && { Authorization: `Bearer ${token}` }) };
  let payload;
  if (form) payload = form;
  else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }

  const response = await fetch(`${base}${path}`, { method, headers, body: payload });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

const filePart = (name, filename, type, content) => {
  const form = new FormData();
  form.append(name, new Blob([content], { type }), filename);
  return form;
};

const staffToken = async (username, password) => {
  const { body } = await api('POST', '/api/auth/staff-login', { body: { username, password } });
  return body.token;
};

const PASSWORD = 'test123';

// A phone number alone can no longer create an account.
const register = (phone, extra = {}) => api('POST', '/api/auth/register', {
  body: {
    phone, name: 'टेस्ट मरीज़', village: 'रामनगर',
    address: 'गली 4, रामनगर, वाराणसी', password: PASSWORD, ...extra,
  },
});

const loginPatient = async (phone) => {
  const created = await register(phone);
  if (created.status === 201) return created.body.token;   // registration signs you straight in
  const { body } = await api('POST', '/api/auth/login', { body: { phone, password: PASSWORD } });
  return body.token;
};

test.before(async () => {
  // See dev-server.js: the 10s default is too tight for a cold WiredTiger start.
  mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
  await mongoose.connect(mongod.getUri());

  for (const [name, username, role, zone] of [
    ['PRO', 'pro', 'pro', 'All'],
    ['Agent One', 'agent1', 'agent', 'रामनगर'],
    ['Agent Two', 'agent2', 'agent', 'चोलापुर'],
    ['Lab', 'lab', 'lab', 'Central'],
    ['Admin', 'admin', 'admin', 'All'],
  ]) {
    await Staff.create({ name, username, role, zone, password: await bcrypt.hash(`${username}123`, 8), active: true });
  }

  // Patients now need a real profile before they can log in at all.
  for (const [phone, name, village] of [
    ['9999999999', 'राम कुमार', 'रामनगर'],
    ['9876543210', 'सीता देवी', 'चोलापुर'],
    ['9988776655', 'मोहन यादव', 'सारनाथ'],
  ]) {
    await Patient.create({ phone, name, village, address: `${village}, वाराणसी` });
  }

  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server?.close();
  await mongoose.disconnect();
  await mongod?.stop();
});

test('health check reports the service', async () => {
  const { status, body } = await api('GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

test('registration requires name, city, address and a password', async () => {
  const bare = await api('POST', '/api/auth/register', { body: { phone: '9500000001' } });
  assert.equal(bare.status, 400);
  assert.equal(bare.body.code, 'name_required');

  const noCity = await api('POST', '/api/auth/register', {
    body: { phone: '9500000001', name: 'राम' },
  });
  assert.equal(noCity.body.code, 'village_required');

  const noAddress = await api('POST', '/api/auth/register', {
    body: { phone: '9500000001', name: 'राम', village: 'रामनगर' },
  });
  assert.equal(noAddress.body.code, 'address_required');

  const weak = await api('POST', '/api/auth/register', {
    body: { phone: '9500000001', name: 'राम', village: 'रामनगर', address: 'गली 4, रामनगर', password: '123' },
  });
  assert.equal(weak.body.code, 'weak_password');

  const invalidAge = await api('POST', '/api/auth/register', {
    body: {
      phone: '9500000001', name: 'राम', age: 121, village: 'रामनगर',
      address: 'गली 4, रामनगर', password: PASSWORD,
    },
  });
  assert.equal(invalidAge.body.code, 'invalid_age');

  const ok = await register('9500000001', { name: 'राम कुमार', age: 34 });
  assert.equal(ok.status, 201);
  assert.ok(ok.body.token, 'registration signs you in — no second login step');
  assert.equal(ok.body.user.role, 'user');

  // The profile is actually stored — the agent needs somewhere to go.
  const saved = await Patient.findOne({ phone: '9500000001' });
  assert.equal(saved.name, 'राम कुमार');
  assert.equal(saved.age, 34);
  assert.equal(saved.village, 'रामनगर');
  assert.ok(saved.address.length > 5);

  const profile = await api('GET', '/api/auth/me', { token: ok.body.token });
  assert.equal(profile.status, 200);
  assert.equal(profile.body.age, 34);
  assert.ok(profile.body.address);

  const edited = await api('PATCH', '/api/me/settings', {
    token: ok.body.token,
    body: { age: 35, address: 'नया पता, रामनगर, वाराणसी' },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.age, 35);
  assert.equal(edited.body.address, 'नया पता, रामनगर, वाराणसी');

  const badEdit = await api('PATCH', '/api/me/settings', {
    token: ok.body.token, body: { age: -1 },
  });
  assert.equal(badEdit.status, 400);
  assert.equal(badEdit.body.code, 'invalid_age');

  const twice = await register('9500000001');
  assert.equal(twice.status, 409, 'a registered number cannot register again');
});

test('the password is hashed, never stored in plain text', async () => {
  await register('9500000077');
  const saved = await Patient.findOne({ phone: '9500000077' });
  assert.ok(saved.password);
  assert.notEqual(saved.password, PASSWORD, 'password must be hashed');
  assert.match(saved.password, /^\$2[aby]\$/, 'expected a bcrypt hash');
});

test('login works with the right password and fails with the wrong one', async () => {
  await register('9500000002');

  const good = await api('POST', '/api/auth/login', {
    body: { phone: '9500000002', password: PASSWORD },
  });
  assert.equal(good.status, 200);
  assert.ok(good.body.token);
  assert.equal(good.body.user.role, 'user');

  const bad = await api('POST', '/api/auth/login', {
    body: { phone: '9500000002', password: 'wrong-one' },
  });
  assert.equal(bad.status, 401);
  assert.ok(bad.body.message);
});

test('login does not reveal whether a number is registered', async () => {
  const unknown = await api('POST', '/api/auth/login', {
    body: { phone: '9500009999', password: 'whatever' },
  });
  const wrongPassword = await api('POST', '/api/auth/login', {
    body: { phone: '9999999999', password: 'whatever' },
  });

  // Identical answers, or a stranger can enumerate which of your patients exist.
  assert.equal(unknown.status, wrongPassword.status);
  assert.equal(unknown.body.code, wrongPassword.body.code);
  assert.equal(unknown.body.message, wrongPassword.body.message);

  assert.equal(await Patient.findOne({ phone: '9500009999' }), null, 'login must not create an account');
});

test('repeated wrong passwords lock the account', async () => {
  await register('9500000003');
  for (let i = 0; i < 10; i++) {
    await api('POST', '/api/auth/login', { body: { phone: '9500000003', password: 'nope' } });
  }
  const locked = await api('POST', '/api/auth/login', {
    body: { phone: '9500000003', password: PASSWORD },
  });
  assert.equal(locked.status, 429, 'brute-forcing a password must be throttled');
});

test('an order walks the full pipeline across all four staff roles', async () => {
  // --- patient: OTP login -----------------------------------------------------
  const sent = await api('POST', '/api/auth/send-otp', { body: { phone: '9999999999' } });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.devOtp, '1234');

  const verified = await api('POST', '/api/auth/verify-otp', { body: { phone: '9999999999', otp: '1234' } });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.user.role, 'user', 'client Role union expects "user", not "patient"');
  const patient = verified.body.token;

  // A brand-new patient has no order: the client relies on a *bare* null here.
  const empty = await api('GET', '/api/orders/my/latest', { token: patient });
  assert.equal(empty.body, null, 'must be bare null, else the client crashes on latest.order.orderId');

  // --- patient: submit a prescription ----------------------------------------
  const created = await api('POST', '/api/orders', {
    token: patient,
    form: filePart('prescription', 'rx.jpg', 'image/jpeg', 'fake-jpeg-bytes'),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, STATUS.SUBMITTED);
  assert.match(created.body.orderId, /^HD-10\d\d$/, 'codes continue the HD-1041+ series');
  assert.ok(created.body.prescriptionUrl?.startsWith('/uploads/'), 'client reads prescriptionUrl');
  const id = created.body._id;

  // --- the guard that matters: no jumping the queue ---------------------------
  const lab = await staffToken('lab', 'lab123');
  const skipped = await api('POST', `/api/orders/${id}/upload-report`, {
    token: lab,
    form: filePart('report', 'r.pdf', 'application/pdf', 'fake-pdf'),
  });
  assert.equal(skipped.status, 409, 'submitted -> report_ready must be refused');
  assert.equal(skipped.body.code, 'illegal_transition');

  // --- PRO: call, then confirm ------------------------------------------------
  const pro = await staffToken('pro', 'pro123');

  const early = await api('PATCH', `/api/orders/${id}/pro-confirm`, {
    token: pro, body: { tests: ['CBC'], amount: 300 },
  });
  assert.equal(early.status, 400, 'cannot confirm before calling');
  assert.equal(early.body.code, 'call_required');

  const called = await api('PATCH', `/api/orders/${id}/pro-call`, { token: pro });
  assert.equal(called.status, 200);
  assert.equal(called.body.status, STATUS.PRO_REVIEW);

  const confirmed = await api('PATCH', `/api/orders/${id}/pro-confirm`, {
    token: pro, body: { tests: ['CBC', 'Blood Sugar (Fasting)'], amount: 450 },
  });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.status, STATUS.CONFIRMED);
  assert.equal(confirmed.body.amount, 450);

  // --- PRO: assign the least-loaded agent -------------------------------------
  const agents = await api('GET', '/api/staff/agents', { token: pro });
  assert.equal(agents.status, 200);
  assert.ok(agents.body.every(a => typeof a.currentLoad === 'number'));
  const agentId = agents.body[0]._id;

  const assigned = await api('PATCH', `/api/orders/${id}/assign-agent`, {
    token: pro, body: { agentId, pickupSlot: '10:00–12:00' },
  });
  assert.equal(assigned.status, 200);
  assert.equal(assigned.body.status, STATUS.AGENT_ASSIGNED);
  assert.equal(assigned.body.pickupSlot, '10:00–12:00', 'assigned pickup keeps the PRO-selected slot');

  const agentUsername = (await Staff.findById(agentId)).username;
  const agent = await staffToken(agentUsername, `${agentUsername}123`);
  const assignedAgentQueue = await api('GET', '/api/orders', { token: agent });
  assert.equal(
    assignedAgentQueue.body.find(order => order._id === id)?.pickupSlot,
    '10:00–12:00',
    'agent queue receives the selected pickup slot',
  );

  const activeProHistory = await api('GET', '/api/orders/history', { token: pro });
  assert.equal(activeProHistory.status, 200);
  assert.equal(
    activeProHistory.body.some(order => order._id === id),
    false,
    'an active pickup must not appear under Past orders in the PRO panel',
  );

  // --- agent: the two checkboxes gate completion -------------------------------
  const premature = await api('PATCH', `/api/orders/${id}/agent-complete`, { token: agent });
  assert.equal(premature.status, 400, 'cannot complete before taking the sample');
  assert.equal(premature.body.code, 'sample_required');

  await api('PATCH', `/api/orders/${id}/sample-taken`, { token: agent, body: { value: true } });

  const noCash = await api('PATCH', `/api/orders/${id}/agent-complete`, { token: agent });
  assert.equal(noCash.status, 400, 'cash is still owed on a cash order');
  assert.equal(noCash.body.code, 'cash_required');

  await api('PATCH', `/api/orders/${id}/cash-taken`, { token: agent, body: { value: true } });

  const collected = await api('PATCH', `/api/orders/${id}/agent-complete`, {
    token: agent, body: { labTube: 'EDTA' },
  });
  assert.equal(collected.status, 200);
  assert.equal(collected.body.status, STATUS.SAMPLE_COLLECTED, 'sample_collected must actually be reached');

  // --- lab: receive, then upload the report -----------------------------------
  // Even a crafted status query is pinned to the LAB queue, and the payload is
  // redacted at the API boundary rather than merely hidden by the web page.
  const labQueue = await api('GET', '/api/orders?status=submitted', { token: lab });
  assert.equal(labQueue.status, 200);
  const labOrder = labQueue.body.find(order => order._id === id);
  assert.ok(labOrder, 'collected sample must appear in the LAB queue');
  assert.deepEqual(labOrder.tests, ['CBC', 'Blood Sugar (Fasting)']);
  assert.equal(labOrder.labTube, 'EDTA');
  assert.ok(labOrder.patient?.name, 'LAB needs the patient name to match the sample');
  for (const privateField of ['amount', 'prescriptionUrl', 'assignedAgent', 'pro', 'pickupSlot']) {
    assert.equal(labOrder[privateField], undefined, `LAB must not receive ${privateField}`);
  }
  assert.equal(labOrder.patient.phone, undefined, 'LAB must not receive patient contact details');
  assert.equal(labOrder.patient.address, undefined, 'LAB must not receive patient address');

  const received = await api('PATCH', `/api/orders/${id}/lab-confirm`, { token: lab });
  assert.equal(received.status, 200);
  assert.equal(received.body.status, STATUS.LAB_RECEIVED);
  assert.equal(received.body.amount, undefined, 'LAB action responses stay redacted too');

  const report = await api('POST', `/api/orders/${id}/upload-report`, {
    token: lab,
    form: filePart('report', 'report.pdf', 'application/pdf', 'fake-pdf-bytes'),
  });
  assert.equal(report.status, 200);
  assert.equal(report.body.status, STATUS.REPORT_READY);
  assert.ok(report.body.reportUrl?.startsWith('/uploads/'), 'report is a stored file, not a client URL');

  const oldLabOrder = await api('GET', `/api/orders/${id}`, { token: lab });
  assert.equal(oldLabOrder.status, 403, 'LAB cannot browse orders after they leave its queue');

  // Finished work remains in the particular staff account's History panel.
  for (const [role, token] of [['pro', pro], ['agent', agent], ['lab', lab]]) {
    const staffHistory = await api('GET', '/api/orders/history', { token });
    assert.equal(staffHistory.status, 200);
    assert.ok(staffHistory.body.some(order => order._id === id), `${role} must retain its completed order`);
    if (role === 'lab') {
      const historical = staffHistory.body.find(order => order._id === id);
      assert.equal(historical.amount, undefined, 'LAB history remains redacted');
      assert.equal(historical.patient.phone, undefined, 'LAB history hides patient contact details');
    }
  }

  // --- the audit trail the patient tracker reads --------------------------------
  const history = await api('GET', `/api/orders/${id}/status-history`, { token: patient });
  assert.equal(history.status, 200);
  assert.equal(history.body.stepIndex, 4);
  assert.deepEqual(
    history.body.history.map(h => h.status),
    [STATUS.SUBMITTED, STATUS.PRO_REVIEW, STATUS.CONFIRMED,
      STATUS.AGENT_ASSIGNED, STATUS.SAMPLE_COLLECTED, STATUS.LAB_RECEIVED, STATUS.REPORT_READY],
  );

  // report_ready is terminal.
  const again = await api('PATCH', `/api/orders/${id}/lab-confirm`, { token: lab });
  assert.equal(again.status, 409);
});

// The OTP path stays alive behind AUTH_MODE, so it keeps its tests: flipping the
// flag back to SMS must not land on code that quietly rotted.
test('a wrong OTP is rejected and eventually locks out', async () => {
  await register('9000011111');
  await api('POST', '/api/auth/send-otp', { body: { phone: '9000011111' } });
  const bad = await api('POST', '/api/auth/verify-otp', { body: { phone: '9000011111', otp: '9999' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'invalid_otp');
  assert.ok(bad.body.message, 'client shows body.message to the user');

  for (let i = 0; i < 5; i++) {
    await api('POST', '/api/auth/verify-otp', { body: { phone: '9000011111', otp: '9999' } });
  }
  const locked = await api('POST', '/api/auth/verify-otp', { body: { phone: '9000011111', otp: '1234' } });
  assert.equal(locked.status, 429, 'brute-forcing a 4-digit OTP must be throttled');
});

test('the OTP is not stored in plaintext', async () => {
  await register('9000022222');
  await api('POST', '/api/auth/send-otp', { body: { phone: '9000022222' } });
  const row = await Patient.findOne({ phone: '9000022222' });
  assert.ok(row.otpHash, 'otp must be hashed');
  assert.notEqual(row.otpHash, '1234');
  assert.equal(row.otp, undefined);
});

test('an agent cannot touch another agent\'s pickup', async () => {
  const pro = await staffToken('pro', 'pro123');
  const other = await staffToken('agent2', 'agent2123');

  const patientAuth = await api('POST', '/api/auth/verify-otp', { body: { phone: '9999999999', otp: '1234' } });
  await api('POST', '/api/auth/send-otp', { body: { phone: '9999999999' } });
  const login = await api('POST', '/api/auth/verify-otp', { body: { phone: '9999999999', otp: '1234' } });
  const patient = login.body.token || patientAuth.body.token;

  const created = await api('POST', '/api/orders', {
    token: patient,
    form: filePart('prescription', 'rx.jpg', 'image/jpeg', 'bytes'),
  });
  const id = created.body._id;

  await api('PATCH', `/api/orders/${id}/pro-call`, { token: pro });
  await api('PATCH', `/api/orders/${id}/pro-confirm`, { token: pro, body: { tests: ['CBC'], amount: 100 } });

  const agent1 = await Staff.findOne({ username: 'agent1' });
  await api('PATCH', `/api/orders/${id}/assign-agent`, {
    token: pro, body: { agentId: agent1.id, pickupSlot: '10:00–12:00' },
  });

  const stolen = await api('PATCH', `/api/orders/${id}/sample-taken`, { token: other, body: { value: true } });
  assert.equal(stolen.status, 403, 'agent2 must not be able to collect agent1\'s sample');

  const fresh = await Order.findById(id);
  assert.equal(fresh.sampleTaken, false);
});

test('a patient cannot read another patient\'s order history', async () => {
  await api('POST', '/api/auth/send-otp', { body: { phone: '9876543210' } });
  const other = await api('POST', '/api/auth/verify-otp', { body: { phone: '9876543210', otp: '1234' } });

  const someoneElsesOrder = await Order.findOne({}).sort('createdAt');
  const peek = await api('GET', `/api/orders/${someoneElsesOrder.id}/status-history`, {
    token: other.body.token,
  });
  assert.equal(peek.status, 403);
});

test('a patient token cannot reach staff endpoints', async () => {
  await api('POST', '/api/auth/send-otp', { body: { phone: '9988776655' } });
  const login = await api('POST', '/api/auth/verify-otp', { body: { phone: '9988776655', otp: '1234' } });

  const forbidden = await api('GET', '/api/orders', { token: login.body.token });
  assert.equal(forbidden.status, 403);

  const stats = await api('GET', '/api/admin/stats/today', { token: login.body.token });
  assert.equal(stats.status, 403);
});

test('only an admin can create staff — nobody can make themselves a PRO', async () => {
  const patient = await loginPatient('9500000010');
  const pro = await staffToken('pro', 'pro123');

  const newStaff = {
    name: 'घुसपैठिया', username: 'intruder', role: 'pro', password: 'hacked1', phone: '9000000099',
  };

  // A patient must not be able to promote themselves.
  const byPatient = await api('POST', '/api/admin/staff', { token: patient, body: newStaff });
  assert.equal(byPatient.status, 403);

  // Nor may a PRO mint more staff.
  const byPro = await api('POST', '/api/admin/staff', { token: pro, body: newStaff });
  assert.equal(byPro.status, 403);

  // Nor an anonymous caller.
  const anon = await api('POST', '/api/admin/staff', { body: newStaff });
  assert.equal(anon.status, 401);

  assert.equal(await Staff.findOne({ username: 'intruder' }), null, 'no staff account may exist');

  // The admin can.
  const admin = await staffToken('admin', 'admin123');
  const created = await api('POST', '/api/admin/staff', { token: admin, body: newStaff });
  assert.equal(created.status, 201);
  assert.equal(created.body.role, 'pro');

  // And the account really works.
  const login = await api('POST', '/api/auth/staff-login', {
    body: { username: 'intruder', password: 'hacked1' },
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, 'pro');

  // Deactivating locks them out without erasing their name from past orders.
  await api('PATCH', `/api/admin/staff/${created.body._id}`, { token: admin, body: { active: false } });
  const locked = await api('POST', '/api/auth/staff-login', {
    body: { username: 'intruder', password: 'hacked1' },
  });
  assert.equal(locked.status, 401);
});

test('LAB can add, search and edit test names and rates without disable access', async () => {
  const admin = await staffToken('admin', 'admin123');
  const lab = await staffToken('lab', 'lab123');

  const created = await api('POST', '/api/admin/test-catalog', {
    token: admin,
    body: { name: 'CBC', category: 'Blood Test', amount: 300 },
  });
  assert.equal(created.status, 201);

  const addedByLab = await api('POST', '/api/test-catalog', {
    token: lab,
    body: { name: 'Lipid Profile', category: 'Blood Test', amount: 650 },
  });
  assert.equal(addedByLab.status, 201);
  assert.equal(addedByLab.body.name, 'Lipid Profile');
  assert.equal(addedByLab.body.amount, 650, 'LAB sees the rate it maintains');

  const catalog = await api('GET', '/api/test-catalog', { token: lab });
  assert.equal(catalog.status, 200);
  const cbc = catalog.body.find(testItem => testItem.name === 'CBC');
  assert.ok(cbc);
  assert.equal(cbc.category, 'Blood Test');
  assert.equal(cbc.amount, 300, 'LAB catalog includes editable rates');
  assert.equal(cbc.isActive, undefined, 'LAB must not receive management fields');
  assert.ok(catalog.body.some(testItem => testItem.name === 'Lipid Profile'));

  const edited = await api('PATCH', `/api/test-catalog/${created.body._id}`, {
    token: lab, body: { name: 'CBC with Differential', category: 'Haematology', amount: 425 },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.name, 'CBC with Differential');
  assert.equal(edited.body.category, 'Haematology');
  assert.equal(edited.body.amount, 425);
  assert.equal(edited.body.isActive, undefined, 'LAB edit response keeps management fields private');

  const forbiddenAdminRoute = await api('PATCH', `/api/admin/test-catalog/${created.body._id}`, {
    token: lab, body: { isActive: false },
  });
  assert.equal(forbiddenAdminRoute.status, 403, 'LAB still cannot use Admin disable controls');
});

test('an agent already out on a pickup cannot be given another', async () => {
  const admin = await staffToken('admin', 'admin123');
  const pro = await staffToken('pro', 'pro123');

  // A fresh agent with nothing to do.
  const made = await api('POST', '/api/admin/staff', {
    token: admin,
    body: { name: 'सोलो एजेंट', username: 'solo', role: 'agent', password: 'solo123', phone: '9000000077' },
  });
  assert.equal(made.status, 201);
  const soloId = made.body._id;

  const listed = () => api('GET', '/api/staff/agents', { token: pro })
    .then(r => r.body.find(a => a._id === soloId));

  assert.equal((await listed()).busy, false, 'a new agent is free');

  // Give them one order.
  const orderFor = async (phone) => {
    const token = await loginPatient(phone);
    const created = await api('POST', '/api/orders', {
      token, form: filePart('prescription', 'rx.jpg', 'image/jpeg', 'bytes'),
    });
    const id = created.body._id;
    await api('PATCH', `/api/orders/${id}/pro-call`, { token: pro });
    await api('PATCH', `/api/orders/${id}/pro-confirm`, { token: pro, body: { tests: ['CBC'], amount: 100 } });
    return id;
  };

  const first = await orderFor('9500001111');
  const assigned = await api('PATCH', `/api/orders/${first}/assign-agent`, {
    token: pro, body: { agentId: soloId, pickupSlot: '10:00–12:00' },
  });
  assert.equal(assigned.status, 200);
  assert.equal(assigned.body.assignedAgent.name, 'सोलो एजेंट', 'the response says who it went to');

  assert.equal((await listed()).busy, true, 'they are now busy');
  assert.deepEqual((await listed()).busyWith, [assigned.body.orderId]);

  // A second order must not go to them, even if the caller asks.
  const second = await orderFor('9500002222');
  const doubled = await api('PATCH', `/api/orders/${second}/assign-agent`, {
    token: pro, body: { agentId: soloId, pickupSlot: '12:00–14:00' },
  });
  assert.equal(doubled.status, 409, 'a busy agent must not be double-booked');
  assert.equal(doubled.body.code, 'agent_busy');
});

test('staff phone numbers must be ten digits', async () => {
  const admin = await staffToken('admin', 'admin123');
  const long = await api('POST', '/api/admin/staff', {
    token: admin,
    body: { name: 'राम', username: 'longphone', role: 'pro', password: 'ram123', phone: '88795564663445546462152' },
  });
  assert.equal(long.status, 400);
  assert.equal(long.body.code, 'invalid_phone');
  assert.equal(await Staff.findOne({ username: 'longphone' }), null);
});

test('notifications carry both languages', async () => {
  const admin = await staffToken('admin', 'admin123');
  const notes = await api('GET', '/api/notifications', { token: admin });
  assert.ok(notes.body.length > 0);
  const note = notes.body[0];
  assert.ok(note.message, 'Hindi text');
  assert.ok(note.messageEn, 'English text');
  assert.notEqual(note.message, note.messageEn);
});

// The bell is a live feed, not an archive: a dashboard left open all day had built
// up thirty-odd items and the newest one was buried.
test('the bell shows only unread, and can be cleared', async () => {
  const admin = await staffToken('admin', 'admin123');

  const unread = await api('GET', '/api/notifications', { token: admin });
  assert.ok(unread.body.length > 0, 'there is something to see');
  assert.ok(unread.body.every(n => n.read === false), 'only unread by default');

  const history = await api('GET', '/api/notifications?all=1', { token: admin });
  assert.ok(history.body.length >= unread.body.length, 'history is still reachable');

  const cleared = await api('PATCH', '/api/notifications/read-all', { token: admin });
  assert.equal(cleared.status, 200);
  assert.ok(cleared.body.cleared > 0, `cleared ${cleared.body.cleared}`);

  const after = await api('GET', '/api/notifications', { token: admin });
  assert.equal(after.body.length, 0, 'the bell is empty once everything is read');

  const stillThere = await api('GET', '/api/notifications?all=1', { token: admin });
  assert.ok(stillThere.body.length > 0, 'but nothing was deleted');
});

test('admin stats are computed from live orders', async () => {
  const admin = await staffToken('admin', 'admin123');
  const { status, body } = await api('GET', '/api/admin/stats/today', { token: admin });
  assert.equal(status, 200);
  assert.equal(typeof body.newPrescriptions, 'number');
  assert.equal(typeof body.cashCollected, 'number');
  assert.ok(body.cashCollected > 0, 'the completed pipeline order collected cash');
});

test('the analytics trend actually counts today\'s orders', async () => {
  const admin = await staffToken('admin', 'admin123');
  const { status, body } = await api('GET', '/api/admin/stats/overview?days=14', { token: admin });

  assert.equal(status, 200);
  assert.equal(body.trend.length, 14, 'empty days must still appear, or the x-axis lies');

  // The regression this guards: day keys were built from toISOString() (UTC) while
  // Mongo grouped in UTC too, but `since` was a LOCAL midnight — so in IST every
  // bucket missed and the trend line was a flat zero despite real orders existing.
  const charted = body.trend.reduce((sum, day) => sum + day.orders, 0);
  assert.ok(charted > 0, 'orders exist, so the trend cannot be all zeroes');
  assert.equal(charted, body.totalOrders, 'every order created today must land on the trend');

  const last = body.trend[body.trend.length - 1].date;
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  assert.equal(last, today, 'the trend must end on today, not yesterday');
});

test('order codes are unique under concurrent creation', async () => {
  const token = await loginPatient('9111122222');

  // The old `HD-${Date.now().slice(-6)}` scheme collided within a millisecond.
  const results = await Promise.all(Array.from({ length: 5 }, () =>
    api('POST', '/api/orders', {
      token,
      form: filePart('prescription', 'rx.jpg', 'image/jpeg', 'bytes'),
    })));

  assert.ok(results.every(r => r.status === 201), 'all concurrent orders must be created');
  const codes = results.map(r => r.body.orderId);
  assert.equal(new Set(codes).size, codes.length, `order codes collided: ${codes}`);
});
