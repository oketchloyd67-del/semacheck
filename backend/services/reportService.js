const pool = require('../db/pool');
const normalize = require('./normalizeService');
const checkService = require('./checkService');
const webhookService = require('./webhookService');
const { sendContactMessageToManagement } = require('./emailService');

async function submitReport(data, file, fingerprint) {
  const { type, value } = normalize.normalizeSubject(data.checkType, data.subject);
  const subjectHash = normalize.hashSubject(type, value);

  const description = (data.description || '').trim();
  if (!description) throw new Error('Enter a description.');
  if (description.length < 40) throw new Error('Description must be at least 40 characters so our team can review it.');

  // Every report must carry relative evidence: an uploaded file (web form)
  // or a link to proof (API submissions). Nothing goes to the admin queue
  // without it.
  const evidenceUrl = (data.evidenceUrl || '').trim();
  if (!file && !evidenceUrl) {
    throw new Error('Evidence is required — attach a screenshot, message or payment confirmation.');
  }
  if (evidenceUrl && !/^https?:\/\//i.test(evidenceUrl)) {
    throw new Error('Evidence link must be a full http(s) URL.');
  }

  const { rows } = await pool.query(
    `INSERT INTO scam_reports (report_type, subject_value, subject_hash, subject_name, description, amount_lost_kes, evidence_path, reporter_user_id, reporter_email, reporter_fingerprint, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')
     RETURNING *`,
    [type, value, subjectHash, data.subjectName || null, description, Number(data.amountLostKes) || null, file ? file.filename : (evidenceUrl || null), data.userId || null, data.reporterEmail || null, fingerprint || '']
  );
  return rows[0];
}

async function approve(id, adminId) {
  const { rows: report } = await pool.query(
    `UPDATE scam_reports SET status='approved', reviewed_by=$2, reviewed_at=now() WHERE id=$1 RETURNING *`,
    [id, adminId]
  );
  if (!report[0]) throw new Error('Report not found.');
  const rec = report[0];

  await checkService.invalidateSubject(rec.report_type, rec.subject_hash);
  await webhookService.notifySubjectChange(rec.report_type, rec.subject_hash);

  return { report: rec, message: 'Report approved. The verdict engine will re-evaluate the subject.' };
}

async function reject(id, adminId, reason) {
  const { rows: report } = await pool.query(
    `UPDATE scam_reports SET status='rejected', rejection_reason=$3, reviewed_by=$2, reviewed_at=now() WHERE id=$1 RETURNING *`,
    [id, adminId, reason || null]
  );
  if (!report[0]) throw new Error('Report not found.');
  return { report: report[0] };
}

async function remove(id, adminId, reason) {
  const { rows: report } = await pool.query(
    `UPDATE scam_reports SET status='removed', rejection_reason=$3, reviewed_by=$2, reviewed_at=now() WHERE id=$1 RETURNING *`,
    [id, adminId, reason || null]
  );
  if (!report[0]) throw new Error('Report not found.');
  const rec = report[0];
  await checkService.invalidateSubject(rec.report_type, rec.subject_hash);
  await webhookService.notifySubjectChange(rec.report_type, rec.subject_hash);
  return { report: rec, message: 'Report removed. The verdict engine will re-evaluate the subject.' };
}

async function listPublic({ type, page = 1, q } = {}) {
  const limit = 20;
  const offset = (Number(page) - 1) * limit;
  const where = [];
  const params = [];
  let i = 1;
  if (type) {
    where.push(`report_type = $${i++}`);
    params.push(type);
  }
  if (q) {
    where.push(`(subject_value ILIKE $${i} OR subject_name ILIKE $${i})`);
    params.push(`%${q}%`);
    i++;
  }
  const sql = `SELECT id, report_type, subject_value, subject_name, description, amount_lost_kes, status, created_at
               FROM scam_reports WHERE status='approved' ${where.length ? 'AND ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT $${i} OFFSET $${i + 1}`;
  params.push(limit, offset);
  const { rows } = await pool.query(sql, params);

  return rows.map((r) => ({
    id: r.id,
    type: r.report_type,
    subject: maskSubject(r.report_type, r.subject_value),
    name: r.subject_name,
    description: r.description,
    amountLostKes: r.amount_lost_kes,
    status: r.status,
    reportedAt: r.created_at,
  }));
}

function maskSubject(type, value) {
  if (type === 'phone') return value.replace(/^(\d{3})(\d{3})(\d{3})$/, '$1 *** $3');
  if (type === 'paybill' || type === 'job') return value;
  if (type === 'website') {
    const parts = value.split('.');
    if (parts.length > 2) return `${parts[0]}...${parts[parts.length - 1]}`;
    return value;
  }
  return value;
}

module.exports = { submitReport, approve, reject, remove, listPublic, maskSubject };
