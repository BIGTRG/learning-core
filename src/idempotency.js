'use strict';
// Stripe-semantics idempotency (the expired IETF draft is NOT cited as a standard):
// - accepted on every POST, scoped per tenant
// - replay with same fingerprint -> stored response, byte-identical, Idempotent-Replay: true
// - same key + different fingerprint -> 422 problem
// - in flight -> 409
// - retained 24h minimum, swept by scripts/sweep_idempotency.js (never on the request path)

const crypto = require('crypto');
const { ApiProblem } = require('./problems');

function fingerprint(method, path, bodyRaw) {
  return crypto.createHash('sha256')
    .update(method).update('\0').update(path).update('\0').update(bodyRaw || '')
    .digest('hex');
}

/**
 * Returns { replay: {status, body} } | { record: row } | null (no key supplied).
 * Runs inside the request's tenant transaction client.
 */
async function begin(client, tenantId, key, fp) {
  if (!key) return null;
  const ins = await client.query(
    `INSERT INTO idempotency_key (tenant_id, key, fingerprint)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, key) DO NOTHING
     RETURNING id`, [tenantId, key, fp]
  );
  if (ins.rows.length > 0) return { record: ins.rows[0] };

  const { rows } = await client.query(
    `SELECT id, fingerprint, status, response_status, response_body
       FROM idempotency_key WHERE tenant_id = $1 AND key = $2`, [tenantId, key]
  );
  const row = rows[0];
  if (!row) return null; // swept between statements; treat as fresh-less
  if (row.fingerprint !== fp) {
    throw new ApiProblem('idempotency-mismatch',
      'This Idempotency-Key was already used with a different method, path or body.');
  }
  if (row.status === 'in_flight') {
    throw new ApiProblem('idempotency-in-flight',
      'A request with this Idempotency-Key is still being processed. Retry shortly.');
  }
  return { replay: { status: row.response_status, body: row.response_body } };
}

async function finish(client, recordId, status, bodyString) {
  await client.query(
    `UPDATE idempotency_key SET status = 'done', response_status = $2, response_body = $3
      WHERE id = $1`, [recordId, status, bodyString]
  );
}

module.exports = { fingerprint, begin, finish };
