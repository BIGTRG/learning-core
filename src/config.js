'use strict';
// All secrets come from the environment (loaded by PM2 from an env file
// readable only by the service user). Nothing here has a secret default.

// Load the root-only env file (PM2 has no native env_file support).
const fs = require('fs');
const ENV_FILE = process.env.LC_ENV_FILE || '/etc/learning-core/env';
try {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch (_) { /* env file optional in dev/test */ }

const need = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing required env: ${k}`);
  return v;
};

module.exports = {
  port: parseInt(process.env.PORT || '8461', 10),
  listenHost: process.env.LISTEN_HOST || '127.0.0.1',
  env: process.env.NODE_ENV || 'production',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://167.233.117.23:8461',
  db: {
    // Through PgBouncer in transaction mode. Never direct in production.
    host: process.env.PGHOST || '127.0.0.1',
    port: parseInt(process.env.PGPORT || '6432', 10),
    database: process.env.PGDATABASE || 'learning_core',
    user: process.env.PGUSER || 'lc_app',
    password: need('PGPASSWORD'),
    max: parseInt(process.env.PG_POOL_MAX || '20', 10),
  },
  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6380', 10),
  },
  rateLimit: {
    defaultPerMin: parseInt(process.env.RATE_LIMIT_DEFAULT || '1000', 10),
    verifyPerIpPerMin: parseInt(process.env.RATE_LIMIT_VERIFY || '30', 10),
  },
  keyCacheTtlMs: 30_000,
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || null, // Trust entity key; wired when provided
    apiVersion: '2026-07-29.dahlia',
    meterActiveLearners: process.env.STRIPE_METER_ACTIVE_LEARNERS || 'lc_active_learners',
    meterApiCalls: process.env.STRIPE_METER_API_CALLS || 'lc_api_calls',
  },
};
