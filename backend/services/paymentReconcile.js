'use strict';
// Normalise the several shapes a payment provider (Tuma) may return from its
// status endpoint. Pure so it can be unit-tested without network or a database.

const SUCCESS_STATES = ['completed', 'complete', 'success', 'successful', 'paid'];
const FAILED_STATES = ['failed', 'failure', 'cancelled', 'canceled', 'error', 'declined'];
const PENDING_STATES = ['pending', 'processing', 'initiated', 'awaiting_payment', 'in_progress'];

function pick(obj, keys) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return null;
}

function interpretTumaStatus(body) {
  const data = (body && body.data && typeof body.data === 'object') ? body.data : (body || {});
  const rawStatus = String(pick(data, ['status', 'payment_status', 'paymentStatus', 'state']) || '').toLowerCase();
  const resultCodeRaw = pick(data, ['result_code', 'resultCode', 'ResultCode', 'response_code']);
  const resultCode = resultCodeRaw === null ? null : Number(resultCodeRaw);
  const receipt = pick(data, ['mpesa_receipt_number', 'mpesa_receipt', 'MpesaReceiptNumber', 'receipt']);
  const reason = pick(data, ['failure_reason', 'message', 'response_description']);
  const providerSaysFailure = resultCode !== null && Number.isFinite(resultCode) && resultCode !== 0;

  if (SUCCESS_STATES.includes(rawStatus) && !providerSaysFailure) {
    return { state: 'success', receipt: receipt || null, reason: null, rawStatus: rawStatus || null };
  }
  if (FAILED_STATES.includes(rawStatus) || providerSaysFailure) {
    return { state: 'failed', receipt: receipt || null, reason: reason || null, rawStatus: rawStatus || null };
  }
  if (PENDING_STATES.includes(rawStatus) || !rawStatus) {
    return { state: 'pending', receipt: receipt || null, reason: reason || null, rawStatus: rawStatus || null };
  }
  // An unrecognised status must never be treated as success.
  return { state: 'unknown', receipt: receipt || null, reason: reason || null, rawStatus: rawStatus || null };
}

module.exports = { interpretTumaStatus };
