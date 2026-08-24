'use strict';
// Structured JSON logs to stdout; PM2 handles rotation.
// Full API keys must never appear here — there is a test that fails if one does.

function line(level, msg, fields) {
  const rec = { ts: new Date().toISOString(), level, msg, ...fields };
  process.stdout.write(JSON.stringify(rec) + '\n');
}

module.exports = {
  info: (msg, fields = {}) => line('info', msg, fields),
  warn: (msg, fields = {}) => line('warn', msg, fields),
  error: (msg, fields = {}) => line('error', msg, fields),
};
