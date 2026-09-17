'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { adminClient, appClient, makeTenant, api, fixture, passAttempt } = require('./helpers');

let admin, A, B;

before(async () => {
  admin = adminClient();
  await admin.connect();
  A = await makeTenant(admin, 'ta');
  B = await makeTenant(admin, 'tb');
});
after(async () => { await admin.end(); });

// ---- role hygiene ----

test('lc_app is not superuser and has no BYPASSRLS', async () => {
  const { rows } = await admin.query(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', ['lc_app']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rolsuper, false);
  assert.equal(rows[0].rolbypassrls, false);
});

test('banned product vocabulary never appears in schema', async () => {
  const banned = ['belt', 'dojo', 'jurisdiction', 'sensei', 'advisor'];
  const { rows } = await admin.query(`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public'`);
  for (const r of rows) {
    for (const w of banned) {
      assert.ok(!r.table_name.includes(w), `table ${r.table_name} contains '${w}'`);
      assert.ok(!r.column_name.includes(w), `column ${r.table_name}.${r.column_name} contains '${w}'`);
    }
  }
});

// ---- isolation ----

test('cross-tenant read returns 404, not 403 (course, lesson, learner, enrollment, attempt, credential)', async () => {
  const fx = await fixture(A.key);
  const { attempt } = await passAttempt(A.key, fx);
  const cred = (await api(A.key, 'POST', '/v1/credentials', { attempt_id: attempt.id })).json;

  const targets = [
    `/v1/courses/${fx.course.id}`,
    `/v1/lessons/${fx.lesson.id}`,
    `/v1/learners/${fx.learner.id}`,
    `/v1/enrollments/${fx.enrollment.id}`,
    `/v1/credentials/${cred.id}`,
    `/v1/assessments/${fx.assessment.id}`,
  ];
  for (const t of targets) {
    const own = await api(A.key, 'GET', t);
    assert.equal(own.status, 200, `owner should read ${t}`);
    const cross = await api(B.key, 'GET', t);
    assert.equal(cross.status, 404, `cross-tenant ${t} must be 404, got ${cross.status}`);
  }
});

test('no tenant context on a warm pooled connection returns zero rows', async () => {
  const app = appClient();
  await app.connect();
  // Warm the backend with tenant context in one transaction…
  await app.query('BEGIN');
  await app.query('SELECT set_config($1, $2, true)', ['app.tenant_id', A.id]);
  const warm = await app.query('SELECT count(*)::int AS n FROM course');
  await app.query('COMMIT');
  assert.ok(warm.rows[0].n >= 1, 'context query should see rows');
  // …then query the same session with no context: GUC is '' — zero rows, no error.
  const cold = await app.query('SELECT count(*)::int AS n FROM course');
  assert.equal(cold.rows[0].n, 0, 'no context must mean zero rows, fail closed');
  await app.end();
});

test('EXPLAIN on a tenant-scoped query uses the tenant_id-leading index', async () => {
  const app = appClient();
  await app.connect();
  await app.query('BEGIN');
  await app.query('SELECT set_config($1, $2, true)', ['app.tenant_id', A.id]);
  // On a table this small the planner rightly prefers a seq scan, which made
  // this assertion flap once the test tenants accumulated. The invariant is
  // that the RLS-injected tenant_id predicate + (created_at, id) ordering is
  // servable by learner_tenant_idx, so force index paths and check WHICH one.
  await app.query('SET LOCAL enable_seqscan = off');
  await app.query('SET LOCAL enable_bitmapscan = off');
  const { rows } = await app.query(
    'EXPLAIN (FORMAT TEXT) SELECT id FROM learner WHERE created_at > now() - interval \'1 day\' ORDER BY created_at, id LIMIT 50');
  await app.query('COMMIT');
  await app.end();
  const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
  assert.ok(/learner_tenant_idx/.test(plan), `plan must use learner_tenant_idx:\n${plan}`);
});

// ---- progress & credentials ----

test('progress is recomputed server-side; credential requires a passing attempt (DB-enforced)', async () => {
  const fx = await fixture(A.key);
  // attempt before completion is locked
  const locked = await api(A.key, 'POST', '/v1/attempts', {
    enrollment_id: fx.enrollment.id, assessment_id: fx.assessment.id,
  });
  assert.equal(locked.status, 409);

  const prog = (await api(A.key, 'POST', `/v1/enrollments/${fx.enrollment.id}/lessons/${fx.lesson.id}/complete`)).json;
  assert.equal(prog.percent_complete, 100);
  assert.equal(prog.complete, true);

  // failing attempt cannot be credentialed — enforced by trigger, checked via direct SQL too
  const attempt = (await api(A.key, 'POST', '/v1/attempts', {
    enrollment_id: fx.enrollment.id, assessment_id: fx.assessment.id,
  })).json;
  const items = (await api(A.key, 'GET', `/v1/assessments/${fx.assessment.id}`)).json.items;
  await api(A.key, 'POST', `/v1/attempts/${attempt.id}/answers`, {
    answers: [{ item_id: items[0].id, response: ['a'] }], // wrong
  });
  const failed = (await api(A.key, 'POST', `/v1/attempts/${attempt.id}/submit`)).json;
  assert.equal(failed.passed, false);
  const credFail = await api(A.key, 'POST', '/v1/credentials', { attempt_id: attempt.id });
  assert.equal(credFail.status, 409);

  // direct SQL bypass of the route must ALSO fail (trigger)
  await admin.query('BEGIN');
  await assert.rejects(
    admin.query(
      `INSERT INTO credential (tenant_id, learner_id, course_id, attempt_id, public_ref)
       VALUES ($1, $2, $3, $4, 'LC-TEST-TEST-TEST-XX')`,
      [A.id, fx.learner.id, fx.course.id, attempt.id]),
    /passing attempt/);
  await admin.query('ROLLBACK');
});

test('partial credit: multi item scores fractionally', async () => {
  const fx = await fixture(A.key);
  await api(A.key, 'POST', `/v1/enrollments/${fx.enrollment.id}/lessons/${fx.lesson.id}/complete`);
  const attempt = (await api(A.key, 'POST', '/v1/attempts', {
    enrollment_id: fx.enrollment.id, assessment_id: fx.assessment.id,
  })).json;
  const items = (await api(A.key, 'GET', `/v1/assessments/${fx.assessment.id}`)).json.items;
  await api(A.key, 'POST', `/v1/attempts/${attempt.id}/answers`, {
    answers: [
      { item_id: items[0].id, response: ['b'] },      // 1/1
      { item_id: items[1].id, response: ['a'] },      // 1 of 2 correct -> 0.5 * 2 = 1
    ],
  });
  const result = (await api(A.key, 'POST', `/v1/attempts/${attempt.id}/submit`)).json;
  assert.equal(result.score_percent, 66.67); // 2 of 3 points
});

test('assessment endpoint never returns answer keys', async () => {
  const fx = await fixture(A.key);
  const res = await api(A.key, 'GET', `/v1/assessments/${fx.assessment.id}`);
  assert.ok(!res.text.includes('answer_key'), 'answer_key must never be serialized');
});

// ---- verify ----

test('public verify works without a key and is exact-match only', async () => {
  const fx = await fixture(A.key);
  const { attempt } = await passAttempt(A.key, fx);
  const cred = (await api(A.key, 'POST', '/v1/credentials', { attempt_id: attempt.id })).json;
  const v = await api(null, 'GET', `/v1/verify/${cred.public_ref}`);
  assert.equal(v.status, 200);
  assert.equal(v.json.learner_name, 'Test Learner');
  assert.equal(v.json.status, 'active');
  const miss = await api(null, 'GET', '/v1/verify/LC-ZZZZ-ZZZZ-ZZZZ-ZZ');
  assert.equal(miss.status, 404);
});
