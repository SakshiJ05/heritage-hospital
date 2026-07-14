const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const secret = () => {
  const value = process.env.JWT_SECRET;
  // Never fall back to a baked-in default: the lowdb backend did, which meant it
  // would happily boot in production with a publicly known signing key.
  if (!value || value.length < 16) {
    throw new Error('JWT_SECRET is required and must be at least 16 characters');
  }
  return value;
};

const sign = payload => jwt.sign(payload, secret(), { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });

const auth = (req, res, next) => {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    req.user = jwt.verify(token, secret());
    next();
  } catch {
    res.status(401).json({ code: 'unauthorized', message: 'कृपया दोबारा लॉगिन करें।' });
  }
};

const allow = (...roles) => (req, res, next) => (
  roles.includes(req.user.role)
    ? next()
    : res.status(403).json({ code: 'forbidden', message: 'आपके पास अनुमति नहीं है।' })
);

const hashOtp = otp => bcrypt.hash(String(otp), 8);
const compareOtp = (otp, hash) => bcrypt.compare(String(otp), hash || '');

module.exports = { sign, auth, allow, hashOtp, compareOtp };
