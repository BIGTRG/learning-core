'use strict';
// Scheduled sweep of idempotency keys older than the retention window (24h
// minimum per Stripe semantics; we keep 48h). Never runs on the request path.

const { Client } = require('pg');

async function main() {
  const client = new Client({
    host: process.env.MIGRATE_PGHOST || '127.0.0.1',
    port: parseInt(process.env.MIGRATE_PGPORT || '5433', 10),
    database: process.env.MIGRATE_PGDATABASE || 'learning_core',
    user: process.env.MIGRATE_PGUSER || 'postgres',
    password: process.env.MIGRATE_PGPASSWORD,
  });
  await client.connect();
  const { rowCount } = await client.query(
    "DELETE FROM idempotency_key WHERE created_at < now() - interval '48 hours'");
  console.log(`swept ${rowCount} idempotency key(s)`);
  // usage_event retention: keep 90 days raw (usage_daily holds the aggregates)
  const { rowCount: ue } = await client.query(
    "DELETE FROM usage_event WHERE occurred_at < now() - interval '90 days'");
  console.log(`swept ${ue} usage event(s)`);
  await client.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
