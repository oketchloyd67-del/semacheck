const crypto = require('crypto');

const ENCRYPTION_KEY = Buffer.from(process.env.WEBHOOK_SECRET_ENC_KEY || '', 'hex');

function encrypt(text) {
  if (ENCRYPTION_KEY.length !== 32) throw new Error('WEBHOOK_SECRET_ENC_KEY must be 32 bytes as hex.');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const ct = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

function decrypt(blob) {
  if (!blob) return null;
  const parts = Buffer.from(blob, 'base64').toString('utf8').split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted blob format.');
  const iv = Buffer.from(parts[0], 'base64');
  const tag = Buffer.from(parts[1], 'base64');
  const ct = Buffer.from(parts[2], 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

module.exports = { encrypt, decrypt, ENCRYPTION_KEY };
