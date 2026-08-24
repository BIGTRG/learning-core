'use strict';
// Metering is a first-class feature: every request writes a usage_event on the
// way through (buffered, flushed every second — never reconstructed from logs).

const { withTenant } = require('./db');
const log = require('./log');

const buffer = [];

function record(tenantId, kind, subjectRef) {
  buffer.push({ tenantId, kind, subjectRef });
}

async function flush() {
  if (buffer.length === 0) return;
  const batch = buffer.splice(0, buffer.length);
  // usage_event is RLS-forced; insert per tenant within tenant context.
  const byTenant = new Map();
  for (const e of batch) {
    if (!byTenant.has(e.tenantId)) byTenant.set(e.tenantId, []);
    byTenant.get(e.tenantId).push(e);
  }
  for (const [tenantId, events] of byTenant) {
    try {
      await withTenant(tenantId, async (c) => {
        const values = [];
        const params = [];
        events.forEach((e, i) => {
          params.push(tenantId, e.kind, e.subjectRef || null);
          values.push(`($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`);
        });
        await c.query(
          `INSERT INTO usage_event (tenant_id, kind, subject_ref) VALUES ${values.join(',')}`,
          params
        );
      });
    } catch (err) {
      log.warn('usage flush failed', { err: String(err.message), count: events.length });
    }
  }
}

let timer = null;
function start() {
  if (!timer) { timer = setInterval(() => flush().catch(() => {}), 1000); timer.unref(); }
}
async function stop() { if (timer) clearInterval(timer); timer = null; await flush(); }

module.exports = { record, flush, start, stop };
