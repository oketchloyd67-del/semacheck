const crypto = require('crypto');
const validator = require('validator');

const HASH_SALT = process.env.REPORT_HASH_SALT || 'semacheck-default-hash-salt';
const REPORT_HASH_SALT = HASH_SALT;

const REPORT_TYPES = [
  'phone',
  'paybill',
  'business',
  'website',
  'job',
  'other',
];

class ValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'ValidationError';
  }
}

function hashSubject(type, normalized) {
  const data = `${type || ''}|${normalized || ''}|${REPORT_HASH_SALT}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

function cleanPhone(raw) {
  if (typeof raw !== 'string') throw new ValidationError('invalid_phone', 'Enter a valid Safaricom phone number.');
  let p = raw.replace(/[\s\-()]/g, '');
  if (/^\+/u.test(p)) p = p.slice(1);
  if (p.startsWith('0') && p.length === 10) p = '254' + p.slice(1);
  if (p.startsWith('254') && p.length === 12 && /^(254)(7|1)\d{8}$/u.test(p)) return p;
  if (p.startsWith('254') && p.length === 9) p = '254' + p;
  throw new ValidationError('invalid_phone', 'Enter a valid Kenyan phone number (2547XXXXXXX or 07XXXXXXX).');
}

function cleanPaybill(raw) {
  const p = String(raw || '').replace(/\D/g, '');
  if (p.length < 5 || p.length > 7) throw new ValidationError('invalid_paybill', 'Enter a valid M-Pesa paybill number (5-7 digits).');
  if (!/^\d{5,7}$/u.test(p)) throw new ValidationError('invalid_paybill', 'Enter a valid paybill number.');
  return p;
}

function cleanBusiness(raw) {
  const cleaned = String(raw || '').replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s{2,}/g, ' ').trim();
  if (cleaned.length < 3 || cleaned.length > 120) {
    throw new ValidationError('invalid_business', 'Business name must be 3-120 characters.');
  }
  return cleaned;
}

function cleanWebsite(raw) {
  const input = String(raw || '').trim();
  if (!input) throw new ValidationError('invalid_website', 'Enter a valid website or domain.');
  let host;
  if (/^https?:\/\//i.test(input)) {
    try {
      host = new URL(input).hostname.toLowerCase();
    } catch {
      throw new ValidationError('invalid_website', 'Enter a valid website or domain.');
    }
  } else {
    host = input.toLowerCase().split('/')[0].split('?')[0];
  }
  host = host.replace(/\.$/, '');
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    throw new ValidationError('invalid_website', 'Do not enter localhost.');
  }
  if (!host || host.includes('..') || host.includes(':')) {
    throw new ValidationError('invalid_website', 'Enter a valid website or domain.');
  }
  const parts = host.split('.');
  if (parts.length < 2) throw new ValidationError('invalid_website', 'Enter a valid domain.');
  if (parts.every((p) => /^\d+$/u.test(p))) {
    throw new ValidationError('invalid_website', 'Enter a valid website or domain.');
  }
  for (const part of parts) {
    if (part.length > 63 || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/u.test(part)) {
      throw new ValidationError('invalid_website', 'Enter a valid website or domain.');
    }
  }
  return host;
}

function cleanOther(raw) {
  const cleaned = String(raw || '').replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s{2,}/g, ' ').trim();
  if (cleaned.length < 3 || cleaned.length > 160) {
    throw new ValidationError('invalid_value', 'Subject must be 3-160 characters.');
  }
  return cleaned;
}

function cleanJob(raw) {
  const cleaned = String(raw || '').replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s{2,}/g, ' ').trim();
  if (cleaned.length < 3 || cleaned.length > 200) {
    throw new ValidationError('invalid_job', 'Employer name must be 3-200 characters.');
  }
  return cleaned;
}

function normalizeSubject(type, raw) {
  switch (type) {
    case 'phone':
      return { type, value: cleanPhone(raw) };
    case 'paybill':
      return { type, value: cleanPaybill(raw) };
    case 'business':
      return { type, value: cleanBusiness(raw) };
    case 'website':
      return { type, value: cleanWebsite(raw) };
    case 'job':
      return { type, value: cleanJob(raw) };
    case 'other':
      return { type, value: cleanOther(raw) };
    default:
      throw new ValidationError('invalid_type', 'Unknown check type.');
  }
}

module.exports = {
  REPORT_TYPES,
  ValidationError,
  hashSubject,
  normalizeSubject,
  cleanPhone,
  cleanPaybill,
  cleanBusiness,
  cleanWebsite,
  cleanJob,
  cleanOther,
};
