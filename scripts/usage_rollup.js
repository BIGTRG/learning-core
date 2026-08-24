'use strict';
// Nightly: aggregate usage_event -> usage_daily, then push to Stripe Billing
// Meters (POST /v1/billing/meter_events). Idempotent and replayable: a failed
// night re-runs without double-billing (deterministic identifiers + pushed_at).
// The legacy usage_records API was REMOVED in 2025-03-31.basil — never use it.
// Runs as a privileged DB user via cron/PM2, not as part of the request path.

const { Client } = require('pg');

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || null;
const STRIPE_API_VERSION = '2026-07-29.dahlia'; // pinned explicitly
const METER_CALLS = process.env.STRIPE_METER_API_CALLS || 'lc_api_calls';
const METER_LEARNERS = process.env.STRIPE_METER_ACTIVE_LEARNERS || 'lc_active_learners';

async function main() {
  const day = process.argv[2] || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const client = new Client({
    host: process.env.MIGRATE_PGHOST || '127.0.0.1',
    port: parseInt(process.env.MIGRATE_PGPORT || '5433', 10),
    database: process.env.MIGRATE_PGDATABASE || 'learning_core',
    user: process.env.MIGRATE_PGUSER || 'postgres',
    password: process.env.MIGRATE_PGPASSWORD,
  });
  await client.connect();

  // Aggregate (idempotent upsert).
  await client.query(`
    INSERT INTO usage_daily (tenant_id, day, api_calls, active_learners)
    SELECT tenant_id, $1::date,
           count(*) FILTER (WHERE kind = 'api_call'),
           count(DISTINCT subject_ref) FILTER (WHERE kind = 'learner_active')
      FROM usage_event
     WHERE occurred_at >= $1::date AND occurred_at < $1::date + 1
     GROUP BY tenant_id
    ON CONFLICT (tenant_id, day) DO UPDATE
      SET api_calls = EXCLUDED.api_calls,
          active_learners = EXCLUDED.active_learners`, [day]);

  const { rows } = await client.query(`
    SELECT u.id, u.tenant_id, t.slug, u.api_calls, u.active_learners, u.pushed_at
      FROM usage_daily u JOIN tenant t ON t.id = u.tenant_id WHERE u.day = $1`, [day]);
  console.log(`rollup ${day}: ${rows.length} tenant(s)`);

  if (!STRIPE_KEY) {
    console.log('STRIPE_SECRET_KEY not set — rollup stored, billing push skipped (waiting on the Trust account key).');
    await client.end();
    return;
  }

  for (const r of rows) {
    if (r.pushed_at) { console.log(`skip push ${r.slug} (already pushed)`); continue; }
    // Deterministic identifiers make the push idempotent on Stripe's side too.
    for (const [meter, value] of [[METER_CALLS, r.api_calls], [METER_LEARNERS, r.active_learners]]) {
      const body = new URLSearchParams({
        event_name: meter,
        identifier: `${meter}:${r.slug}:${day}`,
        'payload[stripe_customer_id]': process.env[`STRIPE_CUSTOMER_${r.slug.toUpperCase()}`] || '',
        'payload[value]': String(value),
      });
      const res = await fetch('https://api.stripe.com/v1/billing/meter_events', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${STRIPE_KEY}`,
          'Stripe-Version': STRIPE_API_VERSION,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
      if (!res.ok) throw new Error(`stripe push failed for ${r.slug}/${meter}: ${res.status} ${await res.text()}`);
    }
    await client.query('UPDATE usage_daily SET pushed_at = now() WHERE id = $1', [r.id]);
    console.log(`pushed ${r.slug}: calls=${r.api_calls} learners=${r.active_learners}`);
  }
  await client.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
