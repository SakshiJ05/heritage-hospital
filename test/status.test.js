const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STATUS, ALL_STATUSES, TRANSITIONS, STEPS, STEP_INDEX,
  canTransition, isTerminal, assertTransition, stepIndex,
} = require('../src/status');

test('every status has a transition rule', () => {
  for (const status of ALL_STATUSES) {
    assert.ok(TRANSITIONS[status], `${status} has no transition rule`);
  }
});

test('every status maps to a step index within the tracker', () => {
  for (const status of ALL_STATUSES) {
    const index = stepIndex(status);
    assert.ok(index >= 0 && index < STEPS.length, `${status} -> bad step ${index}`);
  }
});

test('no transition points at an unknown status', () => {
  for (const [from, targets] of Object.entries(TRANSITIONS)) {
    for (const to of targets) {
      assert.ok(ALL_STATUSES.includes(to), `${from} -> ${to} is not a real status`);
    }
  }
});

test('the happy path is walkable end to end', () => {
  const path = [
    STATUS.SUBMITTED, STATUS.PRO_REVIEW, STATUS.CONFIRMED, STATUS.AGENT_ASSIGNED,
    STATUS.SAMPLE_COLLECTED, STATUS.LAB_RECEIVED, STATUS.REPORT_READY,
  ];
  for (let i = 0; i < path.length - 1; i++) {
    assert.ok(canTransition(path[i], path[i + 1]), `${path[i]} -> ${path[i + 1]} should be legal`);
  }
});

// The bug this whole file exists to prevent: the old backends let lab/admin set
// report_ready on an order that was never called, assigned, collected, or paid.
test('submitted cannot jump straight to report_ready', () => {
  assert.equal(canTransition(STATUS.SUBMITTED, STATUS.REPORT_READY), false);
  assert.throws(
    () => assertTransition(STATUS.SUBMITTED, STATUS.REPORT_READY),
    err => err.status === 409 && err.code === 'illegal_transition',
  );
});

test('no status may skip a step forward', () => {
  const order = [
    STATUS.SUBMITTED, STATUS.PRO_REVIEW, STATUS.CONFIRMED, STATUS.AGENT_ASSIGNED,
    STATUS.SAMPLE_COLLECTED, STATUS.LAB_RECEIVED, STATUS.REPORT_READY,
  ];
  for (let from = 0; from < order.length; from++) {
    for (let to = from + 2; to < order.length; to++) {
      assert.equal(
        canTransition(order[from], order[to]), false,
        `${order[from]} should not reach ${order[to]} directly`,
      );
    }
  }
});

test('orders never move backwards', () => {
  const order = [
    STATUS.SUBMITTED, STATUS.PRO_REVIEW, STATUS.CONFIRMED, STATUS.AGENT_ASSIGNED,
    STATUS.SAMPLE_COLLECTED, STATUS.LAB_RECEIVED, STATUS.REPORT_READY,
  ];
  for (let from = 0; from < order.length; from++) {
    for (let to = 0; to < from; to++) {
      assert.equal(
        canTransition(order[from], order[to]), false,
        `${order[from]} should not go back to ${order[to]}`,
      );
    }
  }
});

test('report_ready and cancelled are terminal', () => {
  assert.ok(isTerminal(STATUS.REPORT_READY));
  assert.ok(isTerminal(STATUS.CANCELLED));
  for (const status of ALL_STATUSES) {
    if (status !== STATUS.REPORT_READY && status !== STATUS.CANCELLED) {
      assert.equal(isTerminal(status), false, `${status} should not be terminal`);
    }
  }
});

test('any live order can be cancelled, and a dead one cannot', () => {
  for (const status of ALL_STATUSES) {
    const expected = !isTerminal(status);
    assert.equal(
      canTransition(status, STATUS.CANCELLED), expected,
      `cancel from ${status} should be ${expected}`,
    );
  }
});

test('re-applying the current status is rejected as a no-op', () => {
  assert.throws(
    () => assertTransition(STATUS.CONFIRMED, STATUS.CONFIRMED),
    err => err.status === 409 && err.code === 'already_in_status',
  );
});

test('an unknown status is rejected', () => {
  assert.throws(
    () => assertTransition(STATUS.SUBMITTED, 'in_lab'),
    err => err.status === 400 && err.code === 'unknown_status',
  );
});

// sample_collected was declared in both old enums but never assigned by any
// endpoint, so the tracker mapped a state that could not occur.
test('sample_collected is reachable', () => {
  assert.ok(canTransition(STATUS.AGENT_ASSIGNED, STATUS.SAMPLE_COLLECTED));
  assert.equal(STEP_INDEX[STATUS.SAMPLE_COLLECTED], 3);
});
