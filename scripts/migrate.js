'use strict';
// Forward-only migrations tracked in schema_migrations. Runs as the migration
// role (superuser or owner), NOT as lc_app — pass PGUSER/PGPASSWORD for the
// migration connection explicitly. Direct to Postgres (5433), not PgBouncer.

const fs = require('fs');
const path = require('path');
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
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);

  const dir = path.join(__dirname, '..', 'db', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const { rows } = await client.query('SELECT 1 FROM schema_migrations WHERE id = $1', [f]);
    if (rows.length) { console.log(`skip  ${f}`); continue; }
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    console.log(`apply ${f}`);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [f]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(`FAILED ${f}: ${e.message}`);
      process.exit(1);
    }
  }
  await client.end();
  console.log('migrations complete');
}

main().catch((e) => { console.error(e); process.exit(1); });
