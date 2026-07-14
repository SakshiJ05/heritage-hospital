// End-to-end smoke test against a RUNNING server (npm run dev:memory).
//   node smoke.js [http://localhost:5000]
// Drives one order through the whole pipeline as all five roles and asserts the
// state machine refuses every shortcut. Useful for verifying a real deployment,
// where the unit tests (which boot their own DB) cannot reach.

const BASE = (process.argv[2] || 'http://localhost:5000') + '/api';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

async function call(method, path, { token, body, file } = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  let payload;
  if (file) {
    payload = new FormData();
    payload.append(file.field, new Blob([file.content], { type: file.type }), file.name);
  } else if (body) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetch(BASE + path, { method, headers, body: payload });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: response.status, data };
}

const staffToken = async (username, password) =>
  (await call('POST', '/auth/staff-login', { body: { username, password } })).data.token;

async function main() {
  console.log(`\nHeritage Diagnostics smoke test → ${BASE}\n`);

  const health = await call('GET', '/health');
  check('API is reachable', health.status === 200, `orders=${health.data?.orders}`);
  if (health.status !== 200) process.exit(1);

  // --- patient ---------------------------------------------------------------
  console.log('\nPatient');
  const otp = await call('POST', '/auth/send-otp', { body: { phone: '9999999999' } });
  check('OTP requested', otp.status === 200);

  const login = await call('POST', '/auth/verify-otp', {
    body: { phone: '9999999999', otp: otp.data.devOtp || '1234' },
  });
  check('OTP verified', login.status === 200);
  check('role is "user" (client Role union)', login.data.user?.role === 'user');
  const patient = login.data.token;

  const created = await call('POST', '/orders', {
    token: patient,
    file: { field: 'prescription', name: 'rx.jpg', type: 'image/jpeg', content: 'bytes' },
  });
  check('prescription uploaded', created.status === 201, created.data.orderId);
  check('status is submitted', created.data.status === 'submitted');
  check('prescriptionUrl present', Boolean(created.data.prescriptionUrl));
  const id = created.data._id;

  // --- the guard --------------------------------------------------------------
  console.log('\nState machine');
  const lab = await staffToken('lab', 'lab123');
  const jump = await call('POST', `/orders/${id}/upload-report`, {
    token: lab,
    file: { field: 'report', name: 'r.pdf', type: 'application/pdf', content: 'pdf' },
  });
  check('submitted -> report_ready REFUSED', jump.status === 409 && jump.data.code === 'illegal_transition');

  // --- PRO --------------------------------------------------------------------
  console.log('\nPRO');
  const pro = await staffToken('pro', 'pro123');

  const early = await call('PATCH', `/orders/${id}/pro-confirm`, {
    token: pro, body: { tests: ['CBC'], amount: 300 },
  });
  check('confirm before call REFUSED', early.status === 400 && early.data.code === 'call_required');

  const called = await call('PATCH', `/orders/${id}/pro-call`, { token: pro });
  check('pro-call -> pro_review', called.data.status === 'pro_review');

  const confirmed = await call('PATCH', `/orders/${id}/pro-confirm`, {
    token: pro, body: { tests: ['CBC', 'Blood Sugar (Fasting)'], amount: 450 },
  });
  check('pro-confirm -> confirmed', confirmed.data.status === 'confirmed');

  const agents = (await call('GET', '/staff/agents', { token: pro })).data;
  check('agents sorted by load (fewest first)',
    agents.every((a, i) => i === 0 || a.currentLoad >= agents[i - 1].currentLoad),
    agents.map(a => `${a.name}(${a.currentLoad})`).join(', '));

  const chosen = agents[0];
  const assigned = await call('PATCH', `/orders/${id}/assign-agent`, {
    token: pro, body: { agentId: chosen._id, pickupSlot: '10:00–12:00' },
  });
  check('assign-agent -> agent_assigned', assigned.data.status === 'agent_assigned');

  // --- agent ------------------------------------------------------------------
  console.log(`\nAgent (${chosen.name})`);
  const wrongAgent = await staffToken(
    chosen.username === 'agent1' ? 'agent2' : 'agent1',
    'agent123',
  );
  const stolen = await call('PATCH', `/orders/${id}/sample-taken`, {
    token: wrongAgent, body: { value: true },
  });
  check("another agent's pickup REFUSED", stolen.status === 403);

  const agent = await staffToken(chosen.username, 'agent123');

  const noSample = await call('PATCH', `/orders/${id}/agent-complete`, { token: agent });
  check('complete without sample REFUSED', noSample.data.code === 'sample_required');

  await call('PATCH', `/orders/${id}/sample-taken`, { token: agent, body: { value: true } });
  const noCash = await call('PATCH', `/orders/${id}/agent-complete`, { token: agent });
  check('complete without cash REFUSED', noCash.data.code === 'cash_required');

  await call('PATCH', `/orders/${id}/cash-taken`, { token: agent, body: { value: true } });
  const collected = await call('PATCH', `/orders/${id}/agent-complete`, {
    token: agent, body: { labTube: 'EDTA' },
  });
  check('agent-complete -> sample_collected', collected.data.status === 'sample_collected');

  // --- lab --------------------------------------------------------------------
  console.log('\nLab');
  const received = await call('PATCH', `/orders/${id}/lab-confirm`, { token: lab });
  check('lab-confirm -> lab_received', received.data.status === 'lab_received');

  const report = await call('POST', `/orders/${id}/upload-report`, {
    token: lab,
    file: { field: 'report', name: 'report.pdf', type: 'application/pdf', content: 'pdf-bytes' },
  });
  check('upload-report -> report_ready', report.data.status === 'report_ready');
  check('report stored as a file, not a client URL',
    String(report.data.reportUrl).startsWith('/uploads/'), report.data.reportUrl);

  const terminal = await call('PATCH', `/orders/${id}/lab-confirm`, { token: lab });
  check('report_ready is terminal', terminal.status === 409);

  // --- tracker + admin ---------------------------------------------------------
  console.log('\nPatient tracker & admin');
  const history = await call('GET', `/orders/${id}/status-history`, { token: patient });
  const path = history.data.history.map(h => h.status);
  check('step index is 4/4', history.data.stepIndex === 4);
  check('full audit trail recorded', path.length === 7, path.join(' → '));

  const admin = await staffToken('admin', 'admin123');
  const stats = (await call('GET', '/admin/stats/today', { token: admin })).data;
  check('admin stats are live aggregates',
    typeof stats.cashCollected === 'number' && stats.cashCollected > 0,
    `cash=₹${stats.cashCollected}`);

  const denied = await call('GET', '/admin/stats/today', { token: patient });
  check('patient cannot read admin stats', denied.status === 403);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(error => { console.error(error); process.exit(1); });
