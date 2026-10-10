const crypto = require('crypto');

const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateId() {
  let id = '';
  for (let i = 0; i < 20; i++) {
    id += chars[crypto.randomInt(chars.length)];
  }
  return id;
}

function requestId(req, res, next) {
  const id = generateId();
  req.id = id;
  res.setHeader('X-Request-Id', id);
  next();
}

module.exports = { requestId, generateId };
