// Real-time fan-out. Every order create/update is broadcast to connected clients,
// so the mobile app and the admin dashboard update without polling or refreshing.
//
// Polling still runs underneath as a safety net (React Query's refetchInterval).
// A dropped socket therefore degrades to "updates arrive in ≤20s" rather than
// "updates stop", which is the right failure mode for an app used in villages
// with bad signal.

const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

let io = null;

// Rooms: staff see every order, a patient only ever sees their own. Notifications
// are personal, so everyone also gets a room of their own.
const ROOM_STAFF = 'staff';
const patientRoom = patientId => `patient:${patientId}`;
const personalRoom = id => `user:${id}`;

function attach(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: process.env.ALLOWED_ORIGINS?.split(',') || '*' },
  });

  // The socket carries the same JWT the REST calls do. Without this, anyone who
  // could reach the port would receive every patient's order stream — the exact
  // hole that a "no auth, just listen" real-time setup leaves open.
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('unauthorized'));
    try {
      socket.user = jwt.verify(token, process.env.JWT_SECRET);
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', socket => {
    const { id, role } = socket.user;
    socket.join(role === 'user' ? patientRoom(id) : ROOM_STAFF);
    socket.join(personalRoom(id));   // this account's own notifications
  });

  console.log('Socket.io: ready');
  return io;
}

// Sent on every status change and on order creation.
function emitOrder(event, order) {
  if (!io || !order) return;

  const payload = typeof order.toObject === 'function' ? order.toObject() : order;
  const patientId = String(payload.patient?._id || payload.patient);

  io.to(ROOM_STAFF).emit(event, payload);
  if (patientId) io.to(patientRoom(patientId)).emit(event, payload);
}

const emitOrderCreated = order => emitOrder('order:new', order);
const emitOrderUpdated = order => emitOrder('order:updated', order);

// Delivered to exactly one account — a patient's "report ready" must not land on
// every staff member's bell.
function emitNotification(notification) {
  if (!io || !notification) return;
  const target = notification.patient || notification.staff;
  if (!target) return;

  io.to(personalRoom(String(target))).emit('notification:new', {
    _id: notification._id,
    type: notification.type,
    message: notification.message,
    messageEn: notification.messageEn,
    order: notification.order,
    read: notification.read,
    createdAt: notification.createdAt,
  });
}

module.exports = { attach, emitOrderCreated, emitOrderUpdated, emitNotification };
