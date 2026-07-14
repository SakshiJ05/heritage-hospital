// The only way an order's status may change.
//
// Routes never assign `order.status` directly — they call moveTo(), which validates
// the transition against the state machine, writes an OrderStatusHistory row, and
// fires notifications. That means an illegal transition is impossible to express,
// rather than merely discouraged.

const { Order, OrderStatusHistory, Patient } = require('./models');
const { assertTransition } = require('./status');
const { notifyTransition, notifyAdmins } = require('./notifications');
const { emitOrderUpdated } = require('./realtime');

const populateOrder = query => query
  .populate('patient', 'name phone village address pushToken')
  .populate('assignedAgent', 'name zone phone')
  .populate('pro', 'name');

async function moveTo(order, status, { staffId = null, note, mutate } = {}) {
  assertTransition(order.status, status);

  // Field updates that belong to this transition are applied *after* the guard,
  // so a rejected transition leaves the order completely untouched.
  if (mutate) await mutate(order);

  order.status = status;
  await order.save();

  await OrderStatusHistory.create({
    order: order._id,
    status,
    changedByStaff: staffId,
    note,
  });

  const fresh = await populateOrder(Order.findById(order._id));
  const patient = fresh.patient || await Patient.findById(order.patient);

  // Broadcast from here, not from the routes: every status change goes through
  // moveTo(), so no endpoint can forget to tell the other apps.
  emitOrderUpdated(fresh);

  // Notification failure must not fail the transition — the sample is already collected.
  notifyTransition(fresh, status, { patient }).catch(error =>
    console.error(`[lifecycle] notify failed for ${fresh.orderId}:`, error.message));

  // The admin watches the whole pipeline, so every move reaches their bell.
  notifyAdmins(fresh, status).catch(error =>
    console.error(`[lifecycle] admin notify failed for ${fresh.orderId}:`, error.message));

  return fresh;
}

module.exports = { moveTo, populateOrder };
