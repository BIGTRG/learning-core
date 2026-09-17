'use strict';
// Test helpers. Tests run against the DEPLOYED stack (PgBouncer + Redis + API)
// plus a privileged direct connection (5433) for fixtures and assertions that
// require superuser (role flags, EXPLAIN through lc_app is separate).

const crypto = require('crypto');
const { Client } = require('pg');

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:8461';

function adminClient() {
  return new Client({
    host: process.env.MIGRATE_PGHOST || '127.0.0.1',
    port: parseInt(process.env.MIGRATE_PGPORT || '5433', 10),
    database: process.env.MIGRATE_PGDATABASE || 'learning_core',
    user: process.env.MIGRATE_PGUSER || 'postgres',
    password: process.env.MIGRATE_PGPASSWORD,
  });
}

function appClient() {
  // lc_app through PgBouncer, like production.
  return new Client({
    host: process.env.PGHOST || '127.0.0.1',
    port: parseInt(process.env.PGPORT || '6432', 10),
    database: process.env.PGDATABASE || 'learning_core',
    user: 'lc_app',
    password: process.env.PGPASSWORD,
  });
}

async function makeTenant(admin, slugPrefix) {
  const slug = `${slugPrefix}${crypto.randomBytes(3).toString('hex')}`.slice(0, 20);
  const t = (await admin.query(
    'INSERT INTO tenant (slug, name) VALUES ($1, $2) RETURNING id, slug', [slug, slug])).rows[0];
  const secret = crypto.randomBytes(20).toString('hex');
  const raw = `${slug}_${secret}`;
  const hash = crypto.createHash('sha256').update(raw, 'utf8').digest();
  await admin.query(
    `INSERT INTO api_key (tenant_id, prefix, key_hash, scopes) VALUES ($1, $2, $3, '{read,write,admin}')`,
    [t.id, raw.slice(0, 12), hash]);
  return { id: t.id, slug: t.slug, key: raw };
}

async function api(key, method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, headers: res.headers, text, json };
}

/** Build a full published course+assessment+enrolled learner; returns ids. */
async function fixture(key, courseExtra = {}) {
  const course = (await api(key, 'POST', '/v1/courses', {
    title: 'T Course', status: 'published',
    modules: [{ title: 'M1', position: 1 }],
    ...courseExtra,
  })).json;
  const lesson = (await api(key, 'POST', `/v1/courses/${course.id}/lessons`, {
    title: 'L1', position: 1, status: 'published',
    blocks: [{ type: 'prose', text: 'x' }],
  })).json;
  const assessment = (await api(key, 'POST', '/v1/assessments', {
    course_id: course.id, title: 'Final', status: 'published', pass_percent: 50,
    items: [
      { position: 1, kind: 'single', prompt: [{ type: 'prose', text: 'q' }], options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], answer_key: ['b'], points: 1 },
      { position: 2, kind: 'multi', prompt: [{ type: 'prose', text: 'q2' }], options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }], answer_key: ['a', 'b'], points: 2 },
    ],
  })).json;
  const learner = (await api(key, 'POST', '/v1/learners', {
    external_ref: `u-${Date.now()}-${Math.random()}`, display_name: 'Test Learner',
  })).json;
  const enrollment = (await api(key, 'POST', '/v1/enrollments', {
    learner_id: learner.id, course_id: course.id,
  })).json;
  return { course, lesson, assessment, learner, enrollment };
}

async function passAttempt(key, fx) {
  await api(key, 'POST', `/v1/enrollments/${fx.enrollment.id}/lessons/${fx.lesson.id}/complete`);
  const attempt = (await api(key, 'POST', '/v1/attempts', {
    enrollment_id: fx.enrollment.id, assessment_id: fx.assessment.id,
  })).json;
  const items = (await api(key, 'GET', `/v1/assessments/${fx.assessment.id}`)).json.items;
  await api(key, 'POST', `/v1/attempts/${attempt.id}/answers`, {
    answers: [
      { item_id: items[0].id, response: ['b'] },
      { item_id: items[1].id, response: ['a', 'b'] },
    ],
  });
  const result = (await api(key, 'POST', `/v1/attempts/${attempt.id}/submit`)).json;
  return { attempt, result };
}

module.exports = { BASE, adminClient, appClient, makeTenant, api, fixture, passAttempt };
