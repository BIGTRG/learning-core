'use strict';
// Seed: two tenants with genuinely different progression schemes, exercised
// through the HTTP API (not direct SQL) so the seed doubles as a smoke test.
//   node scripts/seed.js <base_url> <tenantA_key> <tenantB_key>

const BASE = process.argv[2] || 'http://127.0.0.1:8461';
const KEY_A = process.argv[3];
const KEY_B = process.argv[4];

async function call(key, method, path, body, idemKey) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(idemKey ? { 'Idempotency-Key': idemKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function seedTenant(key, label, scheme) {
  const course = await call(key, 'POST', '/v1/courses', {
    title: scheme.courseTitle,
    summary: `${label} demonstration course`,
    status: 'published',
    modules: [{ title: 'Module 1', position: 1 }, { title: 'Module 2', position: 2 }],
  });
  const lessons = [];
  for (let i = 1; i <= 4; i++) {
    lessons.push(await call(key, 'POST', `/v1/courses/${course.id}/lessons`, {
      title: `Lesson ${i}`,
      position: i,
      module_position: i <= 2 ? 1 : 2,
      est_minutes: 10,
      status: 'published',
      blocks: [
        { type: 'prose', text: `Body of lesson ${i} for ${label}.` },
        { type: 'list', items: ['point one', 'point two'] },
        { type: 'trap', text: 'A common mistake to avoid.' },
      ],
      citations: [{ authority: 'Example authority', verified_on: '2026-08-01' }],
    }));
  }
  const assessment = await call(key, 'POST', '/v1/assessments', {
    course_id: course.id,
    title: `${scheme.courseTitle} — final`,
    pass_percent: 80,
    status: 'published',
    items: [
      { position: 1, kind: 'single', prompt: [{ type: 'prose', text: '2 + 2?' }], options: [{ id: 'a', text: '3' }, { id: 'b', text: '4' }], answer_key: ['b'], points: 1 },
      { position: 2, kind: 'multi', prompt: [{ type: 'prose', text: 'Pick the even numbers.' }], options: [{ id: 'a', text: '1' }, { id: 'b', text: '2' }, { id: 'c', text: '4' }], answer_key: ['b', 'c'], points: 2 },
    ],
  });
  const learner = await call(key, 'POST', '/v1/learners', {
    external_ref: `${label}-user-1`, display_name: `${label} Demo Learner`,
  });
  const enrollment = await call(key, 'POST', '/v1/enrollments', {
    learner_id: learner.id, course_id: course.id,
  });
  for (const l of lessons) {
    await call(key, 'POST', `/v1/enrollments/${enrollment.id}/lessons/${l.id}/complete`);
  }
  const attempt = await call(key, 'POST', '/v1/attempts', {
    enrollment_id: enrollment.id, assessment_id: assessment.id,
  });
  await call(key, 'POST', `/v1/attempts/${attempt.id}/answers`, {
    answers: [
      { item_id: (await call(key, 'GET', `/v1/assessments/${assessment.id}`)).items[0].id, response: ['b'] },
      { item_id: (await call(key, 'GET', `/v1/assessments/${assessment.id}`)).items[1].id, response: ['b', 'c'] },
    ],
  });
  const result = await call(key, 'POST', `/v1/attempts/${attempt.id}/submit`);
  const credential = await call(key, 'POST', '/v1/credentials', { attempt_id: attempt.id }, `seed-${label}-cred`);
  console.log(`${label}: course=${course.id} score=${result.score_percent}% passed=${result.passed} ref=${credential.public_ref}`);
  return credential.public_ref;
}

async function main() {
  if (!KEY_A || !KEY_B) { console.error('usage: seed.js <base> <keyA> <keyB>'); process.exit(1); }
  // Tenant A: nine-rank scheme; Tenant B: three-level scheme. Both defined by
  // their own vocabulary in their own apps — the core only sees ranks.
  const refA = await seedTenant(KEY_A, 'tenant-a', { courseTitle: 'Foundations of Practice' });
  const refB = await seedTenant(KEY_B, 'tenant-b', { courseTitle: 'Operator Certification' });
  // public verify, no key
  for (const ref of [refA, refB]) {
    const res = await fetch(`${BASE}/v1/verify/${ref}`);
    console.log(`verify ${ref}: ${res.status} ${(await res.json()).learner_name || ''}`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
