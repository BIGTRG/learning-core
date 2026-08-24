'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { BASE, adminClient, makeTenant, api, fixture } = require('./helpers');

let admin, T;

before(async () => {
  admin = adminClient();
  await admin.connect();
  T = await makeTenant(admin, 'th');
});
after(async () => { await admin.end(); });

// ---- idempotency (Stripe semantics) ----

test('idempotency: replay returns byte-identical body with Idempotent-Replay', async () => {
  const key = `idem-${crypto.randomUUID()}`;
  const body = { external_ref: `idem-${Date.now()}`, display_name: 'Idem Learner' };
  const first = await api(T.key, 'POST', '/v1/learners', body, { 'Idempotency-Key': key });
  assert.equal(first.status, 201);
  const replay = await api(T.key, 'POST', '/v1/learners', body, { 'Idempotency-Key': key });
  assert.equal(replay.status, 201);
  assert.equal(replay.text, first.text, 'replay must be byte-identical');
  assert.equal(replay.headers.get('idempotent-replay'), 'true');
});

test('idempotency: same key + different body -> 422 problem', async () => {
  const key = `idem-${crypto.randomUUID()}`;
  await api(T.key, 'POST', '/v1/learners',
    { external_ref: `x-${Date.now()}`, display_name: 'One' }, { 'Idempotency-Key': key });
  const second = await api(T.key, 'POST', '/v1/learners',
    { external_ref: `y-${Date.now()}`, display_name: 'Two' }, { 'Idempotency-Key': key });
  assert.equal(second.status, 422);
  assert.ok(second.json.type.endsWith('/problems/idempotency-mismatch'));
});

test('idempotency keys are tenant-scoped: two tenants may use the same key string', async () => {
  const T2 = await makeTenant(admin, 'ti');
  const key = `shared-${crypto.randomUUID()}`;
  const r1 = await api(T.key, 'POST', '/v1/learners',
    { external_ref: `a-${Date.now()}`, display_name: 'A' }, { 'Idempotency-Key': key });
  const r2 = await api(T2.key, 'POST', '/v1/learners',
    { external_ref: `b-${Date.now()}`, display_name: 'B' }, { 'Idempotency-Key': key });
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 201);
});

// ---- pagination ----

test('cursor pagination is stable across a concurrent insert', async () => {
  const stamp = Date.now();
  for (let i = 0; i < 5; i++) {
    await api(T.key, 'POST', '/v1/learners', { external_ref: `pg-${stamp}-${i}`, display_name: `P${i}` });
  }
  const page1 = (await api(T.key, 'GET', '/v1/learners?limit=3')).json;
  assert.equal(page1.data.length, 3);
  assert.equal(page1.has_more, true);
  // concurrent insert between pages
  await api(T.key, 'POST', '/v1/learners', { external_ref: `pg-${stamp}-new`, display_name: 'New' });
  const page2 = (await api(T.key, 'GET', `/v1/learners?limit=200&cursor=${page1.next_cursor}`)).json;
  const ids1 = new Set(page1.data.map((r) => r.id));
  for (const r of page2.data) assert.ok(!ids1.has(r.id), 'no row may repeat across pages');
});

test('limit above 200 is rejected with 422, not clamped', async () => {
  const res = await api(T.key, 'GET', '/v1/learners?limit=500');
  assert.equal(res.status, 422);
});

// ---- rate limiting ----

test('rate limit returns 429 with GitHub-style headers and Retry-After', async () => {
  const { rows } = await admin.query(
    `INSERT INTO tenant (slug, name, rate_limit_per_min) VALUES ($1, $1, 5) RETURNING id, slug`,
    [`rl${crypto.randomBytes(3).toString('hex')}`]);
  const t = rows[0];
  const raw = `${t.slug}_${crypto.randomBytes(20).toString('hex')}`;
  await admin.query(
    `INSERT INTO api_key (tenant_id, prefix, key_hash, scopes) VALUES ($1, $2, $3, '{read}')`,
    [t.id, raw.slice(0, 12), crypto.createHash('sha256').update(raw).digest()]);

  let limited = null;
  for (let i = 0; i < 10; i++) {
    const res = await api(raw, 'GET', '/v1/courses');
    assert.ok(res.headers.get('x-ratelimit-limit'), 'limit header on every response');
    assert.ok(res.headers.get('x-ratelimit-remaining') !== null);
    assert.ok(res.headers.get('x-ratelimit-reset'));
    if (res.status === 429) { limited = res; break; }
  }
  assert.ok(limited, 'should hit the limit');
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.ok(limited.json.type.endsWith('/problems/rate-limited'));
});

// ---- errors ----

test('every error response validates as RFC 9457 problem+json', async () => {
  const cases = [
    await api(null, 'GET', '/v1/courses'),                       // 401
    await api(T.key, 'GET', `/v1/courses/${crypto.randomUUID()}`), // 404
    await api(T.key, 'POST', '/v1/learners', { nope: true }),     // 422
    await api(T.key, 'GET', '/v1/nonexistent'),                   // 404 route
  ];
  for (const res of cases) {
    assert.ok(res.status >= 400);
    assert.ok(res.json, 'problem body must be JSON');
    for (const k of ['type', 'title', 'status', 'detail', 'instance', 'request_id']) {
      assert.ok(res.json[k] !== undefined, `problem missing ${k}: ${res.text}`);
    }
    assert.equal(res.json.status, res.status);
    // the type URL must resolve
    const page = await fetch(res.json.type);
    assert.equal(page.status, 200, `problem type page must exist: ${res.json.type}`);
  }
});

test('insufficient scope names the scope in detail', async () => {
  const { rows } = await admin.query('SELECT id, slug FROM tenant WHERE id = $1', [T.id]);
  const raw = `${rows[0].slug}_${crypto.randomBytes(20).toString('hex')}`;
  await admin.query(
    `INSERT INTO api_key (tenant_id, prefix, key_hash, scopes) VALUES ($1, $2, $3, '{read}')`,
    [T.id, raw.slice(0, 12), crypto.createHash('sha256').update(raw).digest()]);
  const res = await api(raw, 'POST', '/v1/learners', { external_ref: 'x', display_name: 'X' });
  assert.equal(res.status, 403);
  assert.ok(res.json.detail.includes("requires 'write'"));
});

// ---- keys ----

test('revoked key stops working after cache purge', async () => {
  const raw = `${T.slug}_${crypto.randomBytes(20).toString('hex')}`;
  const digest = crypto.createHash('sha256').update(raw).digest();
  await admin.query(
    `INSERT INTO api_key (tenant_id, prefix, key_hash, scopes) VALUES ($1, $2, $3, '{read}')`,
    [T.id, raw.slice(0, 12), digest]);
  assert.equal((await api(raw, 'GET', '/v1/courses')).status, 200);
  await admin.query('UPDATE api_key SET revoked_at = now() WHERE key_hash = $1', [digest]);
  // publish purge like scripts/tenant.js revoke does
  const { createClient } = require('redis');
  const r = createClient({ socket: { host: '127.0.0.1', port: parseInt(process.env.REDIS_PORT || '6380', 10) } });
  await r.connect();
  await r.publish('lc:key_purge', digest.toString('hex'));
  await r.quit();
  await new Promise((s) => setTimeout(s, 300));
  assert.equal((await api(raw, 'GET', '/v1/courses')).status, 401);
});

// ---- openapi ----

test('generated OpenAPI matches the committed file', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const committed = fs.readFileSync(path.join(__dirname, '..', 'openapi.json'), 'utf8');
  const live = (await api(null, 'GET', '/v1/openapi.json')).json;
  assert.deepEqual(live, JSON.parse(committed), 'run npm run openapi > openapi.json and commit');
});

test('openapi is served and is 3.1', async () => {
  const res = await api(null, 'GET', '/v1/openapi.json');
  assert.equal(res.status, 200);
  assert.equal(res.json.openapi, '3.1.0');
});

// ---- health ----

test('health and ready are separate endpoints', async () => {
  assert.equal((await api(null, 'GET', '/v1/health')).status, 200);
  assert.equal((await api(null, 'GET', '/v1/ready')).status, 200);
});
