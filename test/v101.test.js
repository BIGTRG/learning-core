'use strict';
// v1.0.1 — schemes/ranks over HTTP, rank meta, stale citations, approvals.
// v1.0.2 — course.assessments, enrollment.completed_lesson_ids, attempt read + per-item results.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { adminClient, makeTenant, api, fixture, passAttempt } = require('./helpers');

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

// ---- v1.0.2 read shapes ----

test('course detail lists its assessments; enrollment exposes completed lesson ids; attempt is readable with per-item points', async () => {
  const fx = await fixture(A.key);
  const course = await api(A.key, 'GET', `/v1/courses/${fx.course.id}`);
  assert.equal(course.status, 200);
  assert.deepEqual(course.json.assessments.map((a) => a.id), [fx.assessment.id]);
  assert.equal(course.json.assessments[0].pass_percent, 50);
  assert.ok(!('items' in course.json.assessments[0]));

  const before = await api(A.key, 'GET', `/v1/enrollments/${fx.enrollment.id}`);
  assert.deepEqual(before.json.completed_lesson_ids, []);
  const { attempt, result } = await passAttempt(A.key, fx);
  const after = await api(A.key, 'GET', `/v1/enrollments/${fx.enrollment.id}`);
  assert.deepEqual(after.json.completed_lesson_ids, [fx.lesson.id]);

  assert.equal(result.items.length, 2);
  assert.ok(result.items.every((i) => 'points_awarded' in i && 'points' in i && !('answer_key' in i)));
  assert.equal(result.items.reduce((s, i) => s + i.points_awarded, 0), 3);

  const read = await api(A.key, 'GET', `/v1/attempts/${attempt.id}`);
  assert.equal(read.status, 200, read.text);
  assert.equal(read.json.status, 'scored');
  assert.equal(read.json.passed, true);
  assert.equal(read.json.items.length, 2);
  assert.ok(read.json.items.every((i) => i.answered === true && !('answer_key' in i) && !('response' in i)));
  assert.equal((await api(B.key, 'GET', `/v1/attempts/${attempt.id}`)).status, 404);
  assert.equal(JSON.stringify(read.json).includes('answer_key'), false);
});

// ---- v1.0.3 answer key for server-side graders ----

test('answer key is readable only with admin scope, only within the tenant, and only on its own path', async () => {
  const fx = await fixture(A.key);
  const ok = await api(A.key, 'GET', `/v1/assessments/${fx.assessment.id}/answer-key`);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.assessment_id, fx.assessment.id);
  assert.deepEqual(ok.json.items.map((i) => i.answer_key), [['b'], ['a', 'b']]);
  assert.equal(ok.json.items[1].points, 2);
  const rw = await readOnlyKey(A);
  const denied = await api(rw, 'GET', `/v1/assessments/${fx.assessment.id}/answer-key`);
  assert.equal(denied.status, 403, denied.text);
  assert.equal(denied.json.type.endsWith('insufficient-scope'), true);
  assert.equal((await api(B.key, 'GET', `/v1/assessments/${fx.assessment.id}/answer-key`)).status, 404);
  const plain = await api(A.key, 'GET', `/v1/assessments/${fx.assessment.id}`);
  assert.equal(plain.text.includes('answer_key'), false);
});

// ---- v1.0.4: credential revoke (one-way, reason on public verify), rank meta on verify, learner PATCH ----

test('revoke is one-way with a required reason; public verify shows revoked + reason + rank meta and no extra personal data', async () => {
  const scheme = (await api(A.key, 'POST', '/v1/schemes', {
    name: `Verify meta ${crypto.randomBytes(2).toString('hex')}`,
    ranks: [{ name: 'Step one', position: 1, meta: { fill: '#CC6B2C', ink: '#0E1922' } }],
  })).json;
  const fx = await fixture(A.key, { scheme_id: scheme.id, rank_id: scheme.ranks[0].id });
  const { attempt } = await passAttempt(A.key, fx);
  const cred = (await api(A.key, 'POST', '/v1/credentials', { attempt_id: attempt.id })).json;
  assert.equal(cred.status, 'active');

  // verify before revocation carries the rank meta
  const v0 = await api(null, 'GET', `/v1/verify/${cred.public_ref}`);
  assert.equal(v0.status, 200, v0.text);
  assert.equal(v0.json.status, 'active');
  assert.deepEqual(v0.json.rank_meta, { fill: '#CC6B2C', ink: '#0E1922' });
  assert.equal(v0.json.rank_name, 'Step one');
  assert.equal(v0.json.revoke_reason, null);

  // reason is required
  const noReason = await api(A.key, 'POST', `/v1/credentials/${cred.id}/revoke`, {});
  assert.equal(noReason.status, 422);

  // other tenant cannot revoke it (404, never 403)
  const cross = await api(B.key, 'POST', `/v1/credentials/${cred.id}/revoke`, { reason: 'not mine' });
  assert.equal(cross.status, 404);

  const rev = await api(A.key, 'POST', `/v1/credentials/${cred.id}/revoke`, { reason: 'Issued in error: assessment attempt was invalidated.' });
  assert.equal(rev.status, 200, rev.text);
  assert.equal(rev.json.status, 'revoked');
  assert.ok(rev.json.revoked_at);
  assert.equal(rev.json.revoke_reason, 'Issued in error: assessment attempt was invalidated.');

  // second revoke is refused; nothing changes
  const again = await api(A.key, 'POST', `/v1/credentials/${cred.id}/revoke`, { reason: 'again' });
  assert.equal(again.status, 409);
  const read = await api(A.key, 'GET', `/v1/credentials/${cred.id}`);
  assert.equal(read.json.revoke_reason, 'Issued in error: assessment attempt was invalidated.');
  assert.equal(read.json.revoked_at, rev.json.revoked_at);

  // the database refuses reactivation even for a direct superuser update
  await assert.rejects(
    admin.query(`UPDATE credential SET status = 'active', revoked_at = NULL, revoke_reason = NULL WHERE id = $1`, [cred.id]),
    /revocation is permanent/);

  const v1 = await api(null, 'GET', `/v1/verify/${cred.public_ref}`);
  assert.equal(v1.status, 200);
  assert.equal(v1.json.status, 'revoked');
  assert.equal(v1.json.revoke_reason, 'Issued in error: assessment attempt was invalidated.');
  assert.ok(v1.json.revoked_at);
  assert.deepEqual(Object.keys(v1.json).sort(), [
    'course_title', 'issued_at', 'issuer', 'learner_name', 'public_ref', 'rank_meta', 'rank_name', 'revoke_reason', 'revoked_at', 'status',
  ]);
});

test('PATCH learner: display_name changes, external_ref stays; moving external_ref onto an existing one is 409; empty patch is 422', async () => {
  const ref = `ulid_${crypto.randomBytes(6).toString('hex')}`;
  const other = `ulid_${crypto.randomBytes(6).toString('hex')}`;
  const l = (await api(A.key, 'POST', '/v1/learners', { external_ref: ref, display_name: 'Before Change' })).json;
  await api(A.key, 'POST', '/v1/learners', { external_ref: other, display_name: 'Someone Else' });

  const p1 = await api(A.key, 'PATCH', `/v1/learners/${l.id}`, { display_name: 'After Change' });
  assert.equal(p1.status, 200, p1.text);
  assert.equal(p1.json.display_name, 'After Change');
  assert.equal(p1.json.external_ref, ref);
  assert.equal(p1.json.id, l.id);

  const clash = await api(A.key, 'PATCH', `/v1/learners/${l.id}`, { external_ref: other });
  assert.equal(clash.status, 409);

  const empty = await api(A.key, 'PATCH', `/v1/learners/${l.id}`, {});
  assert.equal(empty.status, 422);

  const unknown = await api(A.key, 'PATCH', `/v1/learners/${l.id}`, { email: 'x@example.com' });
  assert.equal(unknown.status, 422);

  const cross = await api(B.key, 'PATCH', `/v1/learners/${l.id}`, { display_name: 'Hijack' });
  assert.equal(cross.status, 404);

  const fresh = `ulid_${crypto.randomBytes(6).toString('hex')}`;
  const move = await api(A.key, 'PATCH', `/v1/learners/${l.id}`, { external_ref: fresh });
  assert.equal(move.status, 200, move.text);
  assert.equal(move.json.external_ref, fresh);
});
