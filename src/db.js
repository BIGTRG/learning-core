'use strict';
// withTenant() is the ONLY permitted path to the database. No route may call
// pool.query() directly — test/no_direct_pool.test.js greps for it and fails.
// Tenant context is transaction-scoped (set_config(..., true)) which is exactly
// the boundary at which PgBouncer transaction pooling returns the connection.

const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  max: config.db.max,
  // statement_timeout is set at the ROLE level (ALTER ROLE lc_app SET ...):
  // PgBouncer transaction mode rejects it as a client startup parameter.
});

/**
 * Run fn(client) inside one transaction with app.tenant_id set locally.
 * tenantId === null runs with NO tenant context (auth/key lookups, verify fn),
 * where RLS-forced tables legitimately return zero rows.
 */
async function withTenant(tenantId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (tenantId) {
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    }
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* connection may be gone */ }
    throw err;
  } finally {
    client.release();
  }
}

async function end() { await pool.end(); }
async function ping() { await withTenant(null, (c) => c.query('SELECT 1')); }

module.exports = { withTenant, end, ping };
