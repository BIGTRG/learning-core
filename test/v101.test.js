'use strict';
// v1.0.1 — schemes/ranks over HTTP, rank meta, stale citations, approvals.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { adminClient, makeTenant, api, fixture } = require('./helpers');

let admin, A, B;

before(async () => {
  admin = adminClient();
  await admin.connect();
  A = await makeTenant(admin, 'va');
  B = await makeTenant(admin, 'vb');
});
after(async () => { await admin.end(); });

async function readOnlyKey(tenant) {
  const raw = `${tenant.slug}_${crypto.randomBytes(20).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(raw, 'utf8').digest();
  await admin.query(
    `INSERT INTO api_key (tenant_id, prefix, key_hash, scopes) VALUES ($1, $2, $3, '{read,write}')`,
    [tenant.id, raw.slice(0, 12), hash]);
  return raw;
}

// ---- schemes & rank meta ----

test('scheme with ranks is created over HTTP; meta round-trips; ranks come back ordered', async () => {
  const res = await api(A.key, 'POST', '/v1/schemes', {
    name: 'Nine step',
    ranks: [
      { name: 'Third', position: 3, meta: { fill: '#CC6B2C' } },
      { name: 'First', position: 1, meta: { fill: '#D8DCE0' } },
      { name: 'Second', position: 2 },
    ],
  });
  assert.equal(res.status, 201, res.text);
  assert.deepEqual(res.json.ranks.map((r) => r.position), [1, 2, 3]);
  assert.deepEqual(res.json.ranks[0].meta, { fill: '#D8DCE0' });
  assert.deepEqual(res.json.ranks[1].meta, {});

  const got = await api(A.key, 'GET', `/v1/schemes/${res.json.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.json.ranks.length, 3);
  assert.equal(got.json.ranks[2].meta.fill, '#CC6B2C');

  const list = await api(A.key, 'GET', '/v1/schemes');
  assert.ok(list.json.items.some((s) => s.id === res.json.id));

  // course may reference the rank
  const course = await api(A.key, 'POST', '/v1/courses', {
    title: 'Ranked course', scheme_id: res.json.id, rank_id: res.json.ranks[1].id,
  });
  assert.equal(course.status, 201, course.text);
  assert.equal(course.json.rank_id, res.json.ranks[1].id);
});

test('scheme name is unique per tenant (409), duplicate positions are 422', async () => {
  const body = { name: `Dup ${Date.now()}`, ranks: [{ name: 'a', position: 1 }] };
  assert.equal((await api(A.key, 'POST', '/v1/schemes', body)).status, 201);
  const dup = await api(A.key, 'POST', '/v1/schemes', body);
  assert.equal(dup.status, 409);
  // other tenant may reuse the name
  assert.equal((await api(B.key, 'POST', '/v1/schemes', body)).status, 201);
  const bad = await api(A.key, 'POST', '/v1/schemes', {
    name: `Bad ${Date.now()}`, ranks: [{ name: 'a', position: 1 }, { name: 'b', position: 1 }],
  });
  assert.equal(bad.status, 422);
});

test('rank meta can be replaced; oversized or non-object meta is rejected', async () => {
  const s = (await api(A.key, 'POST', '/v1/schemes', {
    name: `Meta ${Date.now()}`, ranks: [{ name: 'only', position: 1, meta: { a: 1 } }],
  })).json;
  const rank = s.ranks[0];
  const upd = await api(A.key, 'POST', `/v1/ranks/${rank.id}/meta`, { meta: { fill: '#000', label: 'x' } });
  assert.equal(upd.status, 200, upd.text);
  assert.deepEqual(upd.json.meta, { fill: '#000', label: 'x' });
  assert.equal((await api(A.key, 'POST', `/v1/ranks/${rank.id}/meta`, { meta: [] })).status, 422);
  assert.equal((await api(A.key, 'POST', `/v1/ranks/${rank.id}/meta`, { meta: { big: 'x'.repeat(2100) } })).status, 422);
});

test('schemes and ranks are tenant-isolated (404 cross-tenant); scheme writes need admin scope', async () => {
  const s = (await api(A.key, 'POST', '/v1/schemes', {
    name: `Iso ${Date.now()}`, ranks: [{ name: 'r', position: 1 }],
  })).json;
  assert.equal((await api(B.key, 'GET', `/v1/schemes/${s.id}`)).status, 404);
  assert.equal((await api(B.key, 'POST', `/v1/ranks/${s.ranks[0].id}/meta`, { meta: { x: 1 } })).status, 404);
  const rw = await readOnlyKey(A);
  assert.equal((await api(rw, 'POST', '/v1/schemes', { name: 'nope', ranks: [{ name: 'r', position: 1 }] })).status, 403);
  assert.equal((await api(rw, 'GET', '/v1/schemes')).status, 200);
});

// ---- stale content ----

test('stale content lists citations older than N days or never verified, within the tenant only', async () => {
  const course = (await api(A.key, 'POST', '/v1/courses', { title: 'Stale course', status: 'published' })).json;
  const old = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
  const fresh = new Date().toISOString().slice(0, 10);
  const lesson = (await api(A.key, 'POST', `/v1/courses/${course.id}/lessons`, {
    title: 'Cited', position: 1, status: 'published', blocks: [{ type: 'prose', text: 'x' }],
    citations: [
      { authority: 'Old Authority', verified_on: old },
      { authority: 'Fresh Authority', verified_on: fresh },
      { authority: 'Never Verified' },
    ],
  })).json;
  assert.equal(lesson.status, 'published');

  const res = await api(A.key, 'GET', '/v1/content/stale');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.days, 180);
  const mine = res.json.data.filter((c) => c.lesson_id === lesson.id);
  assert.deepEqual(mine.map((c) => c.authority).sort(), ['Never Verified', 'Old Authority']);
  const oldRow = mine.find((c) => c.authority === 'Old Authority');
  assert.ok(oldRow.days_since_verified >= 399 && oldRow.days_since_verified <= 401);
  assert.equal(oldRow.course_id, course.id);
  assert.equal(mine.find((c) => c.authority === 'Never Verified').days_since_verified, null);

  // wider window drops the 400-day-old one, keeps the never-verified one
  const wide = await api(A.key, 'GET', '/v1/content/stale?days=1000');
  assert.deepEqual(wide.json.data.filter((c) => c.lesson_id === lesson.id).map((c) => c.authority), ['Never Verified']);

  // other tenant sees none of it
  const other = await api(B.key, 'GET', '/v1/content/stale');
  assert.equal(other.json.data.filter((c) => c.lesson_id === lesson.id).length, 0);

  assert.equal((await api(A.key, 'GET', '/v1/content/stale?days=0')).status, 422);
  assert.equal((await api(A.key, 'GET', '/v1/content/stale?days=abc')).status, 422);
});

test('stale content paginates with a cursor', async () => {
  const course = (await api(A.key, 'POST', '/v1/courses', { title: 'Paged course' })).json;
  await api(A.key, 'POST', `/v1/courses/${course.id}/lessons`, {
    title: 'Many', position: 1, blocks: [{ type: 'prose', text: 'x' }],
    citations: Array.from({ length: 5 }, (_, i) => ({ authority: `P${i}` })),
  });
  const p1 = await api(A.key, 'GET', '/v1/content/stale?limit=2');
  assert.equal(p1.json.data.length, 2);
  assert.equal(p1.json.has_more, true);
  const p2 = await api(A.key, 'GET', `/v1/content/stale?limit=2&cursor=${encodeURIComponent(p1.json.next_cursor)}`);
  assert.equal(p2.status, 200);
  assert.notEqual(p2.json.data[0].id, p1.json.data[0].id);
});

// ---- approvals ----

test('approvals: admin records one per subject; listed by subject; subject must exist in tenant', async () => {
  const fx = await fixture(A.key);
  const create = await api(A.key, 'POST', '/v1/approvals', {
    subject_kind: 'course', subject_id: fx.course.id,
    approver_role: 'legal', approver_ref: 'reviewer@example.org', note: 'Reviewed.',
  });
  assert.equal(create.status, 201, create.text);
  assert.equal(create.json.approver_role, 'legal');
  assert.match(create.json.approved_on, /^\d{4}-\d{2}-\d{2}/);

  const dated = await api(A.key, 'POST', '/v1/approvals', {
    subject_kind: 'lesson', subject_id: fx.lesson.id,
    approver_role: 'editor', approver_ref: 'ed-1', approved_on: '2026-01-15',
  });
  assert.equal(dated.status, 201, dated.text);
  assert.ok(String(dated.json.approved_on).startsWith('2026-01-15'));

  const list = await api(A.key, 'GET', `/v1/approvals?subject_kind=course&subject_id=${fx.course.id}`);
  assert.equal(list.status, 200, list.text);
  assert.equal(list.json.data.length, 1);
  assert.equal(list.json.data[0].approver_ref, 'reviewer@example.org');

  const byRole = await api(A.key, 'GET', `/v1/approvals?approver_role=legal`);
  assert.ok(byRole.json.data.every((a) => a.approver_role === 'legal'));

  // subject from another tenant, or missing: 404
  assert.equal((await api(B.key, 'POST', '/v1/approvals', {
    subject_kind: 'course', subject_id: fx.course.id, approver_role: 'legal', approver_ref: 'x',
  })).status, 404);
  assert.equal((await api(A.key, 'POST', '/v1/approvals', {
    subject_kind: 'assessment', subject_id: crypto.randomUUID(), approver_role: 'legal', approver_ref: 'x',
  })).status, 404);
  // cross-tenant list sees nothing
  const otherList = await api(B.key, 'GET', `/v1/approvals?subject_id=${fx.course.id}`);
  assert.equal(otherList.json.data.length, 0);
});

test('approvals: write-scope keys cannot record approvals; bad filters are 422; bad date is 422', async () => {
  const fx = await fixture(A.key);
  const rw = await readOnlyKey(A);
  assert.equal((await api(rw, 'POST', '/v1/approvals', {
    subject_kind: 'course', subject_id: fx.course.id, approver_role: 'legal', approver_ref: 'x',
  })).status, 403);
  assert.equal((await api(rw, 'GET', '/v1/approvals')).status, 200);
  assert.equal((await api(A.key, 'GET', '/v1/approvals?subject_kind=belt')).status, 422);
  assert.equal((await api(A.key, 'GET', '/v1/approvals?subject_id=nope')).status, 422);
  assert.equal((await api(A.key, 'POST', '/v1/approvals', {
    subject_kind: 'course', subject_id: fx.course.id, approver_role: 'legal', approver_ref: 'x', approved_on: '15/01/2026',
  })).status, 422);
});

test('approvals are append-only for the app role (no UPDATE/DELETE grant)', async () => {
  const { rows } = await admin.query(`
    SELECT privilege_type FROM information_schema.role_table_grants
     WHERE grantee = 'lc_app' AND table_name = 'approval'`);
  const privs = rows.map((r) => r.privilege_type);
  assert.ok(privs.includes('INSERT') && privs.includes('SELECT'), `lc_app privs on approval: ${privs}`);
  assert.ok(!privs.includes('UPDATE') && !privs.includes('DELETE'), `approval must be append-only for lc_app: ${privs}`);
});
