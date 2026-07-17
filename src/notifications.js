// Central notification service. Every status transition funnels through
// notifyTransition(), so adding a channel (or muting an event) is a one-file change.
//
// Every message is written in BOTH languages at the time it happens. A notification
// records what was said, so re-translating it later would be a rewrite of history —
// but the reader still gets to flip the app's language, so both are stored and the
// client picks one.
//
// The SMS/push/email senders are adapters. With no provider credentials configured
// they log instead of sending — real seams, not stubs.

const { Notification } = require('./models');
const { STATUS } = require('./status');
const { emitNotification } = require('./realtime');

const push = require('./push');

const hasSms = () => Boolean(process.env.SMS_API_KEY && process.env.SMS_SENDER_ID);
const hasEmail = () => Boolean(process.env.SMTP_URL);

async function sendSms(phone, message) {
  if (!phone) return { channel: 'sms', sent: false, reason: 'no_phone' };
  if (!hasSms()) {
    console.log(`[sms:dev] -> ${phone}: ${message}`);
    return { channel: 'sms', sent: false, reason: 'not_configured' };
  }
  const response = await fetch('https://control.msg91.com/api/v5/flow/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authkey: process.env.SMS_API_KEY },
    body: JSON.stringify({
      sender: process.env.SMS_SENDER_ID,
      template_id: process.env.SMS_TEMPLATE_ID,
      recipients: [{ mobiles: `91${String(phone).replace(/\D/g, '').slice(-10)}`, MESSAGE: message }],
    }),
  });
  if (!response.ok) throw new Error(`sms_failed: ${response.status}`);
  return { channel: 'sms', sent: true };
}

// `owner` is the Patient or Staff document the token belongs to. It is passed rather
// than the bare token so a token FCM has declared dead can be cleared on the spot —
// otherwise every future send to that person fails against a token nobody will fix.
async function sendPush(owner, title, message, data = {}) {
  const result = await push.send(owner?.pushToken, title, message, data);

  if (result.dead && owner?._id) {
    const { Patient, Staff } = require('./models');
    const Model = owner.role ? Staff : Patient;   // only staff carry a role
    await Model.updateOne({ _id: owner._id }, { $unset: { pushToken: 1 } }).catch(() => {});
    console.log(`[push] cleared a dead token for ${owner.role || 'patient'} ${owner._id}`);
  }

  return { channel: 'push', ...result };
}

async function sendEmail(to, subject, message) {
  if (!to || !hasEmail()) {
    if (to) console.log(`[email:dev] -> ${to}: ${subject} — ${message}`);
    return { channel: 'email', sent: false, reason: 'not_configured' };
  }
  const nodemailer = require('nodemailer');
  const transport = nodemailer.createTransport(process.env.SMTP_URL);
  await transport.sendMail({ from: process.env.SMTP_FROM, to, subject, text: message });
  return { channel: 'email', sent: true };
}

const rupees = amount => `₹${amount || 0}`;

// What the PATIENT is told. Statuses absent here are internal and say nothing.
const PATIENT_MESSAGES = {
  [STATUS.CONFIRMED]: o => ({
    hi: `आपका ऑर्डर ${o.orderId} confirm हो गया है। जांच: ${o.tests.join(', ') || '—'}. राशि ${rupees(o.amount)}.`,
    en: `Your order ${o.orderId} is confirmed. Tests: ${o.tests.join(', ') || '—'}. Amount ${rupees(o.amount)}.`,
  }),
  [STATUS.AGENT_ASSIGNED]: o => ({
    hi: `${o.orderId}: ${o.assignedAgent?.name || 'हमारा एजेंट'} ${o.pickupSlot || 'जल्द'} आएगा।`,
    en: `${o.orderId}: ${o.assignedAgent?.name || 'Our agent'} will arrive ${o.pickupSlot || 'soon'}.`,
  }),
  [STATUS.SAMPLE_COLLECTED]: o => ({
    hi: `${o.orderId}: आपका sample ले लिया गया है। धन्यवाद।`,
    en: `${o.orderId}: Your sample has been collected. Thank you.`,
  }),
  [STATUS.REPORT_READY]: o => ({
    hi: `${o.orderId}: आपकी रिपोर्ट तैयार है। App में देखें।`,
    en: `${o.orderId}: Your report is ready. Open the app to view it.`,
  }),
  [STATUS.CANCELLED]: o => ({
    hi: `${o.orderId}: आपका ऑर्डर रद्द कर दिया गया है।`,
    en: `${o.orderId}: Your order has been cancelled.`,
  }),
};

// What the ADMIN sees — they watch the whole pipeline, so every move reaches them.
const ADMIN_MESSAGES = {
  [STATUS.PRO_REVIEW]: o => ({
    hi: `${o.orderId}: PRO ने ${o.patient?.name || 'मरीज़'} को कॉल किया`,
    en: `${o.orderId}: PRO called ${o.patient?.name || 'the patient'}`,
  }),
  [STATUS.CONFIRMED]: o => ({
    hi: `${o.orderId}: confirm हुआ — ${rupees(o.amount)}`,
    en: `${o.orderId}: confirmed — ${rupees(o.amount)}`,
  }),
  [STATUS.AGENT_ASSIGNED]: o => ({
    hi: `${o.orderId}: ${o.assignedAgent?.name || 'एजेंट'} को भेजा गया`,
    en: `${o.orderId}: assigned to ${o.assignedAgent?.name || 'an agent'}`,
  }),
  [STATUS.SAMPLE_COLLECTED]: o => ({
    hi: `${o.orderId}: सैंपल लिया गया${o.cashTaken ? ` · ${rupees(o.amount)} कैश` : ''}`,
    en: `${o.orderId}: sample collected${o.cashTaken ? ` · ${rupees(o.amount)} cash` : ''}`,
  }),
  [STATUS.LAB_RECEIVED]: o => ({
    hi: `${o.orderId}: लैब को सैंपल मिला`,
    en: `${o.orderId}: lab received the sample`,
  }),
  [STATUS.REPORT_READY]: o => ({
    hi: `${o.orderId}: रिपोर्ट तैयार`,
    en: `${o.orderId}: report ready`,
  }),
  [STATUS.CANCELLED]: o => ({
    hi: `${o.orderId}: रद्द हुआ`,
    en: `${o.orderId}: cancelled`,
  }),
};

async function record({ patient, staff, order, type, text, channels }) {
  const notification = await Notification.create({
    patient: patient?._id ?? patient,
    staff: staff?._id ?? staff,
    order: order?._id ?? order,
    type,
    message: text.hi,
    messageEn: text.en,
    channels,
  });

  emitNotification(notification);
  return notification;
}

// Fire-and-log: a dead SMS gateway must never roll back a sample collection.
async function notifyTransition(order, status, { patient } = {}) {
  const build = PATIENT_MESSAGES[status];
  if (!build || !patient) return [];
  const text = build(order);

  const results = await Promise.allSettled([
    sendSms(patient.phone, text.hi),
    // `data` rides along so tapping the notification lands on the right order rather
    // than dumping the patient on the home screen to find it themselves.
    sendPush(patient, 'Heritage Diagnostics', text.hi, {
      type: status, orderId: order.orderId, order: String(order._id),
    }),
    ...(status === STATUS.REPORT_READY && patient.email
      ? [sendEmail(patient.email, `रिपोर्ट तैयार — ${order.orderId}`, text.hi)]
      : []),
  ]);

  const delivered = results
    .filter(r => r.status === 'fulfilled' && r.value.sent)
    .map(r => r.value.channel);

  results
    .filter(r => r.status === 'rejected')
    .forEach(r => console.error(`[notify] ${order.orderId} ${status}:`, r.reason?.message || r.reason));

  await record({ patient, order, type: status, text, channels: delivered.length ? delivered : ['in_app'] });
  return delivered;
}

// Told to the PRO when a prescription lands, to the agent when work is theirs, and to
// the lab when a sample is inbound. This is the path that has to wake a phone in a
// pocket — the whole failure mode is a prescription nobody is told about.
async function notifyStaff(staff, order, text, type) {
  if (!staff) return;

  const results = await Promise.allSettled([
    sendSms(staff.phone, text.hi),
    sendPush(staff, 'Heritage Diagnostics', text.hi, {
      type, orderId: order?.orderId, order: order?._id ? String(order._id) : undefined,
    }),
  ]);

  results
    .filter(r => r.status === 'rejected')
    .forEach(r => console.error(`[notify:staff] ${order?.orderId} ${type}:`, r.reason?.message || r.reason));

  // Record what actually went out. This used to be hardcoded to ['in_app'], which made
  // a silent phone indistinguishable from a delivered alert when reading the history.
  const delivered = results
    .filter(r => r.status === 'fulfilled' && r.value.sent)
    .map(r => r.value.channel);

  await record({ staff, order, type, text, channels: delivered.length ? delivered : ['in_app'] });
}

// The admin follows the whole pipeline, so every move reaches them — on the dashboard,
// in the app's bell, and as a push on their phone. Push on every transition is the
// owner's explicit call: they would rather the phone buzz through a busy day than miss
// a step. If that ever becomes too much, narrowing it is a matter of filtering `status`
// here — the per-status messages already exist in ADMIN_MESSAGES.
//
// No SMS: an admin watching a dashboard does not need a text for every sample tube.
async function notifyAdmins(order, status) {
  const build = ADMIN_MESSAGES[status];
  if (!build) return;

  const { Staff } = require('./models');
  const admins = await Staff.find({ role: 'admin', active: true });
  const text = build(order);

  await Promise.all(admins.map(async admin => {
    const result = await sendPush(admin, 'Heritage Diagnostics', text.hi, {
      type: status, orderId: order?.orderId, order: order?._id ? String(order._id) : undefined,
    }).catch(error => {
      console.error(`[notify:admin] ${order?.orderId} ${status}:`, error?.message || error);
      return { sent: false };
    });

    await record({
      staff: admin._id,
      order,
      type: status,
      text,
      channels: result.sent ? ['push', 'in_app'] : ['in_app'],
    });
  }));
}

module.exports = {
  notifyTransition, notifyStaff, notifyAdmins,
  sendSms, sendPush, sendEmail, record,
  PATIENT_MESSAGES, ADMIN_MESSAGES,
};
