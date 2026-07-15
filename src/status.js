// Single source of truth for the order lifecycle.
// Anything that needs to know about order status — route guards, the patient
// step tracker, chip colours, list filters — derives it from this file.
// The mirror of this file on the client is heritagediagnostics/src/constants/status.ts;
// the two are kept in sync by backend/test/status.test.js.

const STATUS = {
  SUBMITTED: 'submitted',
  PRO_REVIEW: 'pro_review',
  CONFIRMED: 'confirmed',
  AGENT_ASSIGNED: 'agent_assigned',
  SAMPLE_COLLECTED: 'sample_collected',
  LAB_RECEIVED: 'lab_received',
  REPORT_READY: 'report_ready',
  CANCELLED: 'cancelled',
};

const ALL_STATUSES = Object.values(STATUS);

// The only legal moves. A status not listed as a key is terminal.
const TRANSITIONS = {
  [STATUS.SUBMITTED]: [STATUS.PRO_REVIEW, STATUS.CANCELLED],
  [STATUS.PRO_REVIEW]: [STATUS.CONFIRMED, STATUS.CANCELLED],
  [STATUS.CONFIRMED]: [STATUS.AGENT_ASSIGNED, STATUS.CANCELLED],
  [STATUS.AGENT_ASSIGNED]: [STATUS.SAMPLE_COLLECTED, STATUS.CANCELLED],
  [STATUS.SAMPLE_COLLECTED]: [STATUS.LAB_RECEIVED, STATUS.CANCELLED],
  [STATUS.LAB_RECEIVED]: [STATUS.REPORT_READY, STATUS.CANCELLED],
  [STATUS.REPORT_READY]: [],
  [STATUS.CANCELLED]: [],
};

const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

const isTerminal = status => (TRANSITIONS[status] || []).length === 0;

// Throws a 409 unless `to` is reachable from `order.status`. Every status write
// in the API goes through this — there is no other way to move an order.
function assertTransition(from, to) {
  if (!ALL_STATUSES.includes(to)) {
    throw Object.assign(new Error(`unknown status: ${to}`), { status: 400, code: 'unknown_status' });
  }
  if (from === to) {
    throw Object.assign(new Error('already_in_status'), {
      status: 409,
      code: 'already_in_status',
      message: 'यह ऑर्डर पहले से इसी चरण में है।',
    });
  }
  if (!canTransition(from, to)) {
    throw Object.assign(new Error(`illegal transition ${from} -> ${to}`), {
      status: 409,
      code: 'illegal_transition',
      message: 'यह कदम अभी नहीं उठाया जा सकता।',
    });
  }
}

// The patient-facing tracker has 5 steps; several statuses share a step.
const STEPS = ['prescription_sent', 'confirmed_call', 'agent_assigned', 'sample_collected', 'report_ready'];

const STEP_INDEX = {
  [STATUS.SUBMITTED]: 0,
  [STATUS.PRO_REVIEW]: 0,
  [STATUS.CONFIRMED]: 1,
  [STATUS.AGENT_ASSIGNED]: 2,
  [STATUS.SAMPLE_COLLECTED]: 3,
  [STATUS.LAB_RECEIVED]: 3,
  [STATUS.REPORT_READY]: 4,
  [STATUS.CANCELLED]: 0,
};

const stepIndex = status => STEP_INDEX[status] ?? 0;

// Which statuses each staff role sees in its work queue by default.
//
// CONFIRMED stays in the PRO queue: when more prescriptions arrive than there are
// free agents, the PRO confirms them but cannot assign an agent yet. Those orders
// must remain visible so the PRO can assign one the moment an agent frees up —
// otherwise a confirmed-but-unassigned order would silently drop out of every queue.
const QUEUES = {
  pro: [STATUS.SUBMITTED, STATUS.PRO_REVIEW, STATUS.CONFIRMED],
  agent: [STATUS.AGENT_ASSIGNED],
  lab: [STATUS.SAMPLE_COLLECTED, STATUS.LAB_RECEIVED],
};

module.exports = {
  STATUS,
  ALL_STATUSES,
  TRANSITIONS,
  STEPS,
  STEP_INDEX,
  QUEUES,
  canTransition,
  isTerminal,
  assertTransition,
  stepIndex,
};
