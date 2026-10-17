// Deprecated shim. The renewal reminders are now the full schedule in
// jobs/sendApiReminders.js (14/7/3/1 days before, due date, then the grace
// period and suspension notice). This file stays so older deployment configs
// that still call it do not send a second, out-of-schedule email.
const { run, sendApiReminders } = require('./sendApiReminders');

module.exports = { run, sendApiReminders };
