'use strict';
// Operator tool: create a tenant and mint API keys. Runs as a privileged DB
// user (direct 5433), never as lc_app. Prints the full key ONCE to the
// operator's terminal — it is stored only as a SHA-256 hash.
//
//   node scripts/tenant.js create <slug> "<Name>"
//   node scripts/tenant.js key <slug> [scopes,comma,separated]
//   node scripts/tenant.js revoke <key_prefix>

const { Client } = require('pg');
const crypto = require('crypto');

function connect() {
  return new Client({
    host: process.env.MIGRATE_PGHOST || '127.0.0.1',
    port: parseInt(process.env.MIGRATE_PGPORT || '5433', 10),
    database: process.env.MIGRATE_PGDATABASE || 'learning_core',
    user: process.env.MIGRATE_PGUSER || 'postgres',
    password: process.env.MIGRATE_PGPASSWORD,
  });
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  const client = connect();
  await client.connect();

  if (cmd === 'create') {
    const { rows } = await client.query(
      `INSERT INTO tenant (slug, name) VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, slug, name`, [a, b || a]);
    console.log(JSON.stringify(rows[0], null, 2));
  } else if (cmd === 'key') {
    const t = (await client.query('SELECT id, slug FROM tenant WHERE slug = $1', [a])).rows[0];
    if (!t) throw new Error(`no tenant '${a}'`);
    const scopes = (b || 'read,write').split(',');
    const secret = crypto.randomBytes(20).toString('hex');
    const raw = `${t.slug}_${secret}`;
    const hash = crypto.createHash('sha256').update(raw, 'utf8').digest();
    const { rows } = await client.query(
      `INSERT INTO api_key (tenant_id, prefix, key_hash, scopes)
       VALUES ($1, $2, $3, $4) RETURNING id, prefix, scopes`,
      [t.id, raw.slice(0, 12), hash, scopes]);
    console.log(JSON.stringify({ ...rows[0], key: raw, note: 'shown once; stored as SHA-256 only' }, null, 2));
  } else if (cmd === 'revoke') {
    const { rows } = await client.query(
      `UPDATE api_key SET revoked_at = now() WHERE prefix = $1 AND revoked_at IS NULL
       RETURNING id, prefix, encode(key_hash, 'hex') AS hash_hex`, [a]);
    console.log(JSON.stringify(rows, null, 2));
    // Publish cache purge so revocation is immediate across workers.
    if (rows.length) {
      try {
        const { createClient } = require('redis');
        const r = createClient({ socket: { host: process.env.REDIS_HOST || '127.0.0.1', port: parseInt(process.env.REDIS_PORT || '6380', 10) } });
        await r.connect();
        for (const row of rows) await r.publish('lc:key_purge', row.hash_hex);
        await r.quit();
      } catch (e) { console.error('cache purge publish failed:', e.message); }
    }
  } else {
    console.error('usage: tenant.js create|key|revoke ...');
    process.exit(1);
  }
  await client.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
