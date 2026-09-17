'use strict';
// The route table. Every entry declares method, path, scope and schemas; the
// OpenAPI document is generated from this table (src/openapi.js), so the spec
// cannot drift from the code. Handlers receive (client, ctx) where client is
// the tenant-scoped transaction from withTenant() — the only path to the DB.

const crypto = require('crypto');
const { ApiProblem } = require('./problems');
const { check } = require('./validate');
const { parseLimit, decodeCursor, packPage } = require('./pagination');
const { scoreAttempt } = require('./scoring');

// ---------- shared schemas ----------

const BLOCKS = { type: 'array', description: 'Typed content blocks (prose, list, table, trap). Never markup.' };

const S = {
  learnerCreate: {
    type: 'object', required: ['external_ref', 'display_name'], additionalProperties: false,
    properties: {
      external_ref: { type: 'string', minLength: 1, maxLength: 200 },
      display_name: { type: 'string', minLength: 1, maxLength: 200 },
    },
  },
  courseCreate: {
    type: 'object', required: ['title'], additionalProperties: false,
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 300 },
      summary: { type: 'string', maxLength: 2000 },
      scheme_id: { type: 'string', format: 'uuid' },
      rank_id: { type: 'string', format: 'uuid' },
      status: { type: 'string', enum: ['draft', 'published'] },
      modules: {
        type: 'array', maxItems: 50,
        items: {
          type: 'object', required: ['title', 'position'], additionalProperties: false,
          properties: { title: { type: 'string', minLength: 1 }, position: { type: 'integer', minimum: 1 } },
        },
      },
    },
  },
  lessonCreate: {
    type: 'object', required: ['title', 'position', 'blocks'], additionalProperties: false,
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 300 },
      summary: { type: 'string', maxLength: 2000 },
      position: { type: 'integer', minimum: 1 },
      module_position: { type: 'integer', minimum: 1 },
      est_minutes: { type: 'integer', minimum: 1, maximum: 600 },
      status: { type: 'string', enum: ['draft', 'published'] },
      blocks: BLOCKS,
      citations: {
        type: 'array', maxItems: 100,
        items: {
          type: 'object', required: ['authority'], additionalProperties: false,
          properties: {
            authority: { type: 'string', minLength: 1, maxLength: 500 },
            url: { type: 'string', maxLength: 1000 },
            verified_on: { type: 'string', maxLength: 10 },
          },
        },
      },
    },
  },
  assessmentCreate: {
    type: 'object', required: ['course_id', 'title', 'items'], additionalProperties: false,
    properties: {
      course_id: { type: 'string', format: 'uuid' },
      title: { type: 'string', minLength: 1, maxLength: 300 },
      pass_percent: { type: 'number', minimum: 1, maximum: 100 },
      time_limit_minutes: { type: 'integer', minimum: 1 },
      max_attempts: { type: 'integer', minimum: 1 },
      status: { type: 'string', enum: ['draft', 'published'] },
      items: {
        type: 'array', minItems: 1, maxItems: 200,
        items: {
          type: 'object', required: ['kind', 'prompt', 'position'], additionalProperties: false,
          properties: {
            position: { type: 'integer', minimum: 1 },
            kind: { type: 'string', enum: ['single', 'multi', 'constructed'] },
            prompt: BLOCKS,
            options: { type: 'array' },
            answer_key: { type: 'array' },
            points: { type: 'number', minimum: 0.25 },
          },
        },
      },
    },
  },
  enrollmentCreate: {
    type: 'object', required: ['learner_id', 'course_id'], additionalProperties: false,
    properties: {
      learner_id: { type: 'string', format: 'uuid' },
      course_id: { type: 'string', format: 'uuid' },
    },
  },
  attemptCreate: {
    type: 'object', required: ['enrollment_id', 'assessment_id'], additionalProperties: false,
    properties: {
      enrollment_id: { type: 'string', format: 'uuid' },
      assessment_id: { type: 'string', format: 'uuid' },
    },
  },
  answersSubmit: {
    type: 'object', required: ['answers'], additionalProperties: false,
    properties: {
      answers: {
        type: 'array', minItems: 1, maxItems: 200,
        items: {
          type: 'object', required: ['item_id', 'response'], additionalProperties: false,
          properties: { item_id: { type: 'string', format: 'uuid' }, response: {} },
        },
      },
    },
  },
  gradeSubmit: {
    type: 'object', required: ['grades'], additionalProperties: false,
    properties: {
      grades: {
        type: 'array', minItems: 1, maxItems: 200,
        items: {
          type: 'object', required: ['item_id', 'points_awarded'], additionalProperties: false,
          properties: {
            item_id: { type: 'string', format: 'uuid' },
            points_awarded: { type: 'number', minimum: 0 },
          },
        },
      },
    },
  },
  credentialCreate: {
    type: 'object', required: ['attempt_id'], additionalProperties: false,
    properties: {
      attempt_id: { type: 'string', format: 'uuid' },
      tag_codes: { type: 'array', maxItems: 100, items: { type: 'string' } },
    },
  },
  schemeCreate: {
    type: 'object', required: ['name', 'ranks'], additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 200 },
      ranks: {
        type: 'array', minItems: 1, maxItems: 50,
        items: {
          type: 'object', required: ['name', 'position'], additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            position: { type: 'integer', minimum: 1 },
            meta: { type: 'object', description: 'Opaque tenant presentation data (e.g. colour). Max 2KB.' },
          },
        },
      },
    },
  },
  rankMeta: {
    type: 'object', required: ['meta'], additionalProperties: false,
    properties: { meta: { type: 'object', description: 'Replaces the rank meta object. Max 2KB.' } },
  },
  approvalCreate: {
    type: 'object', required: ['subject_kind', 'subject_id', 'approver_role', 'approver_ref'], additionalProperties: false,
    properties: {
      subject_kind: { type: 'string', enum: ['course', 'lesson', 'assessment'] },
      subject_id: { type: 'string', format: 'uuid' },
      approver_role: { type: 'string', minLength: 1, maxLength: 100 },
      approver_ref: { type: 'string', minLength: 1, maxLength: 300 },
      approved_on: { type: 'string', maxLength: 10 },
      note: { type: 'string', maxLength: 4000 },
    },
  },
};

// ---------- helpers ----------

async function one(client, sql, params, slugIfMissing = 'not-found', detail = 'The requested resource does not exist.') {
  const { rows } = await client.query(sql, params);
  if (rows.length === 0) throw new ApiProblem(slugIfMissing, detail);
  return rows[0];
}

function publicRef() {
  // LC-XXXX-XXXX-XXXX-XX from an unambiguous alphabet.
  const alpha = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const pick = (n) => Array.from(crypto.randomBytes(n)).map((b) => alpha[b % alpha.length]).join('');
  return `LC-${pick(4)}-${pick(4)}-${pick(4)}-${pick(2)}`;
}

async function recomputeProgress(client, enrollmentId) {
  const row = await one(client, `
    SELECT e.id, e.learner_id, e.course_id,
      (SELECT count(*) FROM lesson l WHERE l.course_id = e.course_id AND l.status = 'published')::int AS total_lessons,
      (SELECT count(*) FROM lesson_progress p JOIN lesson l2 ON l2.id = p.lesson_id
        WHERE p.enrollment_id = e.id AND l2.status = 'published')::int AS completed_lessons
    FROM enrollment e WHERE e.id = $1`, [enrollmentId]);
  const pct = row.total_lessons > 0
    ? Math.round((row.completed_lessons / row.total_lessons) * 10000) / 100 : 0;
  const completedIds = (await client.query(
    `SELECT p.lesson_id FROM lesson_progress p JOIN lesson l ON l.id = p.lesson_id
      WHERE p.enrollment_id = $1 AND l.status = 'published' ORDER BY p.completed_at`, [enrollmentId]))
    .rows.map((r) => r.lesson_id);
  return {
    enrollment_id: row.id,
    learner_id: row.learner_id,
    course_id: row.course_id,
    lessons_total: row.total_lessons,
    lessons_completed: row.completed_lessons,
    completed_lesson_ids: completedIds,
    percent_complete: pct,
    complete: row.total_lessons > 0 && row.completed_lessons >= row.total_lessons,
  };
}

function checkMeta(meta) {
  if (meta === undefined) return;
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new ApiProblem('validation-error', 'meta must be a JSON object.');
  }
  if (Buffer.byteLength(JSON.stringify(meta)) > 2048) {
    throw new ApiProblem('validation-error', 'meta must be 2KB or smaller.');
  }
}

const LIST_QUERY_PARAMS = [
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
  { name: 'cursor', in: 'query', schema: { type: 'string' } },
];

function listWhere(cursor) {
  return cursor ? 'AND (created_at, id) > ($2::timestamptz, $3::uuid)' : '';
}

// ---------- the routes ----------

const ROUTES = [
  // learners
  {
    method: 'POST', path: '/v1/learners', scope: 'write', schema: S.learnerCreate,
    summary: 'Create a learner. external_ref is your own stable user id.',
    handler: async (client, ctx) => {
      const b = ctx.body;
      const { rows } = await client.query(
        `INSERT INTO learner (tenant_id, external_ref, display_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, external_ref) DO UPDATE SET display_name = EXCLUDED.display_name
         RETURNING id, external_ref, display_name, created_at`,
        [ctx.tenantId, b.external_ref, b.display_name]);
      return { status: 201, body: rows[0] };
    },
  },
  {
    method: 'GET', path: '/v1/learners', scope: 'read', queryParams: LIST_QUERY_PARAMS,
    summary: 'List learners (cursor pagination).',
    handler: async (client, ctx) => {
      const limit = parseLimit(ctx.query);
      const cur = decodeCursor(ctx.query.cursor);
      const params = cur ? [limit + 1, cur.createdAt, cur.id] : [limit + 1];
      const { rows } = await client.query(
        `SELECT id, external_ref, display_name, created_at, to_char(created_at AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS.US+00') AS cursor_ts FROM learner
          WHERE true ${listWhere(cur)} ORDER BY created_at, id LIMIT $1`, params);
      return { status: 200, body: packPage(rows, limit) };
    },
  },
  {
    method: 'GET', path: '/v1/learners/:id', scope: 'read',
    summary: 'Fetch one learner.',
    handler: async (client, ctx) => {
      const row = await one(client,
        'SELECT id, external_ref, display_name, created_at FROM learner WHERE id = $1', [ctx.params.id]);
      return { status: 200, body: row };
    },
  },
  {
    method: 'GET', path: '/v1/learners/:id/progress', scope: 'read',
    summary: 'Recomputed progress across all of a learner\'s enrollments.',
    handler: async (client, ctx) => {
      await one(client, 'SELECT id FROM learner WHERE id = $1', [ctx.params.id]);
      const { rows } = await client.query(
        'SELECT id FROM enrollment WHERE learner_id = $1 ORDER BY created_at', [ctx.params.id]);
      const out = [];
      for (const e of rows) out.push(await recomputeProgress(client, e.id));
      return { status: 200, body: { learner_id: ctx.params.id, enrollments: out } };
    },
  },

  // courses & lessons
  {
    method: 'POST', path: '/v1/courses', scope: 'write', schema: S.courseCreate,
    summary: 'Create a course, optionally with modules.',
    handler: async (client, ctx) => {
      const b = ctx.body;
      const { rows } = await client.query(
        `INSERT INTO course (tenant_id, scheme_id, rank_id, title, summary, status)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, title, summary, status, scheme_id, rank_id, created_at`,
        [ctx.tenantId, b.scheme_id || null, b.rank_id || null, b.title, b.summary || '', b.status || 'draft']);
      const course = rows[0];
      const modules = [];
      for (const m of b.modules || []) {
        const r = await client.query(
          `INSERT INTO course_module (tenant_id, course_id, title, position)
           VALUES ($1, $2, $3, $4) RETURNING id, title, position`,
          [ctx.tenantId, course.id, m.title, m.position]);
        modules.push(r.rows[0]);
      }
      return { status: 201, body: { ...course, modules } };
    },
  },
  {
    method: 'GET', path: '/v1/courses', scope: 'read', queryParams: LIST_QUERY_PARAMS,
    summary: 'List courses (cursor pagination).',
    handler: async (client, ctx) => {
      const limit = parseLimit(ctx.query);
      const cur = decodeCursor(ctx.query.cursor);
      const params = cur ? [limit + 1, cur.createdAt, cur.id] : [limit + 1];
      const { rows } = await client.query(
        `SELECT id, title, summary, status, created_at, to_char(created_at AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS.US+00') AS cursor_ts FROM course
          WHERE true ${listWhere(cur)} ORDER BY created_at, id LIMIT $1`, params);
      return { status: 200, body: packPage(rows, limit) };
    },
  },
  {
    method: 'GET', path: '/v1/courses/:id', scope: 'read',
    summary: 'Fetch a course with its modules and lesson metadata (not bodies).',
    handler: async (client, ctx) => {
      const course = await one(client,
        'SELECT id, title, summary, status, scheme_id, rank_id, created_at FROM course WHERE id = $1',
        [ctx.params.id]);
      const modules = (await client.query(
        'SELECT id, title, position FROM course_module WHERE course_id = $1 ORDER BY position',
        [course.id])).rows;
      const lessons = (await client.query(
        `SELECT id, module_id, title, summary, position, est_minutes, status
           FROM lesson WHERE course_id = $1 ORDER BY position`, [course.id])).rows;
      const assessments = (await client.query(
        `SELECT id, title, pass_percent, time_limit_minutes, max_attempts, status
           FROM assessment WHERE course_id = $1 ORDER BY created_at`, [course.id])).rows;
      return { status: 200, body: { ...course, modules, lessons, assessments } };
    },
  },
  {
    method: 'POST', path: '/v1/courses/:id/lessons', scope: 'write', schema: S.lessonCreate,
    summary: 'Add a lesson (typed blocks + citations) to a course.',
    handler: async (client, ctx) => {
      const b = ctx.body;
      const course = await one(client, 'SELECT id FROM course WHERE id = $1', [ctx.params.id]);
      let moduleId = null;
      if (b.module_position) {
        const m = await one(client,
          'SELECT id FROM course_module WHERE course_id = $1 AND position = $2', [course.id, b.module_position],
          'validation-error', `No module at position ${b.module_position} in this course.`);
        moduleId = m.id;
      }
      const { rows } = await client.query(
        `INSERT INTO lesson (tenant_id, course_id, module_id, title, summary, position, est_minutes, blocks, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, course_id, module_id, title, summary, position, est_minutes, status, created_at`,
        [ctx.tenantId, course.id, moduleId, b.title, b.summary || '', b.position,
         b.est_minutes || null, JSON.stringify(b.blocks), b.status || 'draft']);
      const lesson = rows[0];
      for (const c of b.citations || []) {
        await client.query(
          `INSERT INTO citation (tenant_id, lesson_id, authority, url, verified_on)
           VALUES ($1, $2, $3, $4, $5)`,
          [ctx.tenantId, lesson.id, c.authority, c.url || null, c.verified_on || null]);
      }
      return { status: 201, body: lesson };
    },
  },
  {
    method: 'GET', path: '/v1/lessons/:id', scope: 'read',
    summary: 'Fetch a lesson: typed content blocks and citation rows. Never markup.',
    handler: async (client, ctx) => {
      const lesson = await one(client,
        `SELECT id, course_id, module_id, title, summary, position, est_minutes, blocks, status, created_at
           FROM lesson WHERE id = $1`, [ctx.params.id]);
      const citations = (await client.query(
        'SELECT id, authority, url, verified_on FROM citation WHERE lesson_id = $1 ORDER BY created_at',
        [lesson.id])).rows;
      return { status: 200, body: { ...lesson, citations } };
    },
  },

  // assessments
  {
    method: 'POST', path: '/v1/assessments', scope: 'write', schema: S.assessmentCreate,
    summary: 'Create an assessment with its items. Answer keys are stored server-side and never returned.',
    handler: async (client, ctx) => {
      const b = ctx.body;
      await one(client, 'SELECT id FROM course WHERE id = $1', [b.course_id],
        'validation-error', 'course_id does not reference one of your courses.');
      const { rows } = await client.query(
        `INSERT INTO assessment (tenant_id, course_id, title, pass_percent, time_limit_minutes, max_attempts, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, course_id, title, pass_percent, time_limit_minutes, max_attempts, status, created_at`,
        [ctx.tenantId, b.course_id, b.title, b.pass_percent || 80,
         b.time_limit_minutes || null, b.max_attempts || null, b.status || 'draft']);
      const assessment = rows[0];
      for (const item of b.items) {
        if (item.kind !== 'constructed' && (!item.answer_key || item.answer_key.length === 0)) {
          throw new ApiProblem('validation-error',
            `items at position ${item.position}: ${item.kind} items require an answer_key.`);
        }
        await client.query(
          `INSERT INTO assessment_item (tenant_id, assessment_id, position, kind, prompt, options, answer_key, points)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [ctx.tenantId, assessment.id, item.position, item.kind, JSON.stringify(item.prompt),
           JSON.stringify(item.options || []), JSON.stringify(item.answer_key || []), item.points || 1]);
      }
      return { status: 201, body: assessment };
    },
  },
  {
    method: 'GET', path: '/v1/assessments/:id', scope: 'read',
    summary: 'Fetch an assessment and its items — prompts and options only, never answer keys.',
    handler: async (client, ctx) => {
      const a = await one(client,
        `SELECT id, course_id, title, pass_percent, time_limit_minutes, max_attempts, status, created_at
           FROM assessment WHERE id = $1`, [ctx.params.id]);
      const items = (await client.query(
        `SELECT id, position, kind, prompt, options, points
           FROM assessment_item WHERE assessment_id = $1 ORDER BY position`, [a.id])).rows;
      return { status: 200, body: { ...a, items } };
    },
  },
  {
    method: 'GET', path: '/v1/assessments/:id/answer-key', scope: 'admin',
    summary: 'Answer keys for every item of an assessment (admin scope only). For a consumer that grades constructed items server-side and posts points through /v1/attempts/{id}/grade. Never expose to a learner.',
    handler: async (client, ctx) => {
      const a = await one(client, 'SELECT id, course_id, pass_percent FROM assessment WHERE id = $1', [ctx.params.id]);
      const items = (await client.query(
        `SELECT id, position, kind, points, answer_key
           FROM assessment_item WHERE assessment_id = $1 ORDER BY position`, [a.id])).rows
        .map((r) => ({ id: r.id, position: r.position, kind: r.kind, points: Number(r.points), answer_key: r.answer_key }));
      return { status: 200, body: { assessment_id: a.id, course_id: a.course_id, pass_percent: a.pass_percent, items } };
    },
  },

  // enrollments & progress
  {
    method: 'POST', path: '/v1/enrollments', scope: 'write', schema: S.enrollmentCreate,
    summary: 'Enrol a learner in a course.',
    handler: async (client, ctx) => {
      const b = ctx.body;
      await one(client, 'SELECT id FROM learner WHERE id = $1', [b.learner_id],
        'validation-error', 'learner_id does not reference one of your learners.');
      await one(client, 'SELECT id FROM course WHERE id = $1', [b.course_id],
        'validation-error', 'course_id does not reference one of your courses.');
      const { rows } = await client.query(
        `INSERT INTO enrollment (tenant_id, learner_id, course_id) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, learner_id, course_id) DO UPDATE SET learner_id = EXCLUDED.learner_id
         RETURNING id, learner_id, course_id, created_at`,
        [ctx.tenantId, b.learner_id, b.course_id]);
      return { status: 201, body: rows[0] };
    },
  },
  {
    method: 'GET', path: '/v1/enrollments/:id', scope: 'read',
    summary: 'Fetch an enrollment with recomputed progress. The server computes; the client never asserts.',
    handler: async (client, ctx) => {
      await one(client, 'SELECT id FROM enrollment WHERE id = $1', [ctx.params.id]);
      return { status: 200, body: await recomputeProgress(client, ctx.params.id) };
    },
  },
  {
    method: 'POST', path: '/v1/enrollments/:id/lessons/:lessonId/complete', scope: 'write',
    summary: 'Record a lesson completion; returns recomputed course progress.',
    handler: async (client, ctx) => {
      const e = await one(client, 'SELECT id, course_id FROM enrollment WHERE id = $1', [ctx.params.id]);
      const lesson = await one(client,
        'SELECT id, course_id, status FROM lesson WHERE id = $1', [ctx.params.lessonId]);
      if (lesson.course_id !== e.course_id) {
        throw new ApiProblem('validation-error', 'This lesson does not belong to the enrolled course.');
      }
      if (lesson.status !== 'published') {
        throw new ApiProblem('invariant-violation', 'Only published lessons can be completed.');
      }
      await client.query(
        `INSERT INTO lesson_progress (tenant_id, enrollment_id, lesson_id)
         VALUES ($1, $2, $3) ON CONFLICT (tenant_id, enrollment_id, lesson_id) DO NOTHING`,
        [ctx.tenantId, e.id, lesson.id]);
      ctx.learnerActive = true;
      return { status: 200, body: await recomputeProgress(client, e.id) };
    },
  },

  // attempts
  {
    method: 'POST', path: '/v1/attempts', scope: 'write', schema: S.attemptCreate,
    summary: 'Start an assessment attempt. Requires course completion for the enrolled course.',
    handler: async (client, ctx) => {
      const b = ctx.body;
      const e = await one(client, 'SELECT id, course_id FROM enrollment WHERE id = $1', [b.enrollment_id],
        'validation-error', 'enrollment_id does not reference one of your enrollments.');
      const a = await one(client,
        'SELECT id, course_id, status, max_attempts FROM assessment WHERE id = $1', [b.assessment_id],
        'validation-error', 'assessment_id does not reference one of your assessments.');
      if (a.course_id !== e.course_id) {
        throw new ApiProblem('validation-error', 'This assessment does not belong to the enrolled course.');
      }
      if (a.status !== 'published') {
        throw new ApiProblem('invariant-violation', 'Only published assessments can be attempted.');
      }
      const progress = await recomputeProgress(client, e.id);
      if (!progress.complete) {
        throw new ApiProblem('invariant-violation',
          `The course is not complete (${progress.lessons_completed} of ${progress.lessons_total} lessons). The exam is locked until it is.`);
      }
      if (a.max_attempts) {
        const { rows } = await client.query(
          `SELECT count(*)::int AS n FROM attempt WHERE enrollment_id = $1 AND assessment_id = $2`,
          [e.id, a.id]);
        if (rows[0].n >= a.max_attempts) {
          throw new ApiProblem('invariant-violation', 'Maximum attempts reached for this assessment.');
        }
      }
      const { rows } = await client.query(
        `INSERT INTO attempt (tenant_id, enrollment_id, assessment_id)
         VALUES ($1, $2, $3) RETURNING id, enrollment_id, assessment_id, status, started_at`,
        [ctx.tenantId, e.id, a.id]);
      ctx.learnerActive = true;
      return { status: 201, body: rows[0] };
    },
  },
  {
    method: 'POST', path: '/v1/attempts/:id/answers', scope: 'write', schema: S.answersSubmit,
    summary: 'Record answers on an in-progress attempt (upsert per item).',
    handler: async (client, ctx) => {
      const attempt = await one(client,
        'SELECT id, assessment_id, status FROM attempt WHERE id = $1', [ctx.params.id]);
      if (attempt.status !== 'in_progress') {
        throw new ApiProblem('invariant-violation', 'This attempt has already been submitted.');
      }
      for (const ans of ctx.body.answers) {
        await one(client,
          'SELECT id FROM assessment_item WHERE id = $1 AND assessment_id = $2',
          [ans.item_id, attempt.assessment_id],
          'validation-error', `item ${ans.item_id} is not part of this assessment.`);
        await client.query(
          `INSERT INTO attempt_answer (tenant_id, attempt_id, item_id, response)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, attempt_id, item_id) DO UPDATE SET response = EXCLUDED.response`,
          [ctx.tenantId, attempt.id, ans.item_id, JSON.stringify(ans.response)]);
      }
      ctx.learnerActive = true;
      return { status: 200, body: { attempt_id: attempt.id, answers_recorded: ctx.body.answers.length } };
    },
  },
  {
    method: 'POST', path: '/v1/attempts/:id/submit', scope: 'write',
    summary: 'Submit and score an attempt server-side with partial credit. Constructed items park it at needs_grading.',
    handler: async (client, ctx) => {
      const attempt = await one(client,
        'SELECT id, assessment_id, status FROM attempt WHERE id = $1', [ctx.params.id]);
      if (attempt.status !== 'in_progress') {
        throw new ApiProblem('invariant-violation', 'This attempt has already been submitted.');
      }
      const result = await scoreAndStore(client, attempt);
      ctx.learnerActive = true;
      return { status: 200, body: result };
    },
  },
  {
    method: 'GET', path: '/v1/attempts/:id', scope: 'read',
    summary: 'Fetch an attempt with its status, score and per-item points awarded. Never answer keys.',
    handler: async (client, ctx) => {
      const a = await one(client,
        `SELECT id, enrollment_id, assessment_id, status, started_at, submitted_at, score_percent, passed
           FROM attempt WHERE id = $1`, [ctx.params.id]);
      const items = (await client.query(
        `SELECT i.id AS item_id, i.position, i.points, aa.points_awarded, (aa.item_id IS NOT NULL) AS answered
           FROM assessment_item i LEFT JOIN attempt_answer aa ON aa.item_id = i.id AND aa.attempt_id = $1
          WHERE i.assessment_id = $2 ORDER BY i.position`, [a.id, a.assessment_id])).rows
        .map((r) => ({ item_id: r.item_id, position: r.position, points: Number(r.points),
          points_awarded: r.points_awarded === null ? null : Number(r.points_awarded), answered: r.answered }));
      return { status: 200, body: { ...a, items } };
    },
  },
  {
    method: 'POST', path: '/v1/attempts/:id/grade', scope: 'admin', schema: S.gradeSubmit,
    summary: 'Grade constructed items on a needs_grading attempt (admin scope), then finalise the score.',
    handler: async (client, ctx) => {
      const attempt = await one(client,
        'SELECT id, assessment_id, status FROM attempt WHERE id = $1', [ctx.params.id]);
      if (attempt.status !== 'needs_grading') {
        throw new ApiProblem('invariant-violation', 'Only needs_grading attempts can be graded.');
      }
      const manual = new Map();
      for (const g of ctx.body.grades) manual.set(g.item_id, g.points_awarded);
      const result = await scoreAndStore(client, attempt, manual);
      return { status: 200, body: result };
    },
  },

  // credentials
  {
    method: 'POST', path: '/v1/credentials', scope: 'write', schema: S.credentialCreate,
    summary: 'Issue a credential for a passing attempt. The database enforces the passing requirement.',
    handler: async (client, ctx) => {
      const b = ctx.body;
      const attempt = await one(client, `
        SELECT a.id, a.passed, a.status, e.learner_id, e.course_id
          FROM attempt a JOIN enrollment e ON e.id = a.enrollment_id
         WHERE a.id = $1`, [b.attempt_id],
        'validation-error', 'attempt_id does not reference one of your attempts.');
      if (attempt.passed !== true) {
        throw new ApiProblem('invariant-violation', 'A credential requires a passing attempt on record.');
      }
      const existing = await client.query(
        'SELECT id, public_ref, status, issued_at FROM credential WHERE attempt_id = $1', [attempt.id]);
      if (existing.rows.length > 0) return { status: 200, body: existing.rows[0] };

      const ref = publicRef();
      const { rows } = await client.query(
        `INSERT INTO credential (tenant_id, learner_id, course_id, attempt_id, public_ref)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, learner_id, course_id, attempt_id, public_ref, status, issued_at`,
        [ctx.tenantId, attempt.learner_id, attempt.course_id, attempt.id, ref]);
      const cred = rows[0];
      const tags = [];
      for (const code of b.tag_codes || []) {
        const t = await one(client,
          'SELECT id, code, label FROM competency_tag WHERE code = $1', [code],
          'validation-error', `tag code '${code}' does not exist for this tenant.`);
        await client.query(
          `INSERT INTO credential_tag (tenant_id, credential_id, tag_id) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`, [ctx.tenantId, cred.id, t.id]);
        tags.push({ code: t.code, label: t.label });
      }
      return { status: 201, body: { ...cred, tags } };
    },
  },
  {
    method: 'GET', path: '/v1/credentials/:id', scope: 'read',
    summary: 'Fetch one credential with its competency tags.',
    handler: async (client, ctx) => {
      const cred = await one(client,
        `SELECT id, learner_id, course_id, attempt_id, public_ref, status, issued_at, revoked_at
           FROM credential WHERE id = $1`, [ctx.params.id]);
      const tags = (await client.query(`
        SELECT t.code, t.label FROM credential_tag ct JOIN competency_tag t ON t.id = ct.tag_id
         WHERE ct.credential_id = $1`, [cred.id])).rows;
      return { status: 200, body: { ...cred, tags } };
    },
  },

  // usage
  {
    method: 'GET', path: '/v1/usage', scope: 'read',
    queryParams: [
      { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
      { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
    ],
    summary: 'Your own metered usage by day. A customer who cannot audit their bill will not renew.',
    handler: async (client, ctx) => {
      const from = ctx.query.from || '1970-01-01';
      const to = ctx.query.to || '2999-12-31';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        throw new ApiProblem('validation-error', 'from/to must be YYYY-MM-DD.');
      }
      const { rows } = await client.query(
        `SELECT day, api_calls, active_learners FROM usage_daily
          WHERE day >= $1 AND day <= $2 ORDER BY day`, [from, to]);
      return { status: 200, body: { from, to, days: rows } };
    },
  },

  // progression schemes & ranks (vocabulary-neutral; the app names them)
  {
    method: 'POST', path: '/v1/schemes', scope: 'admin', schema: S.schemeCreate,
    summary: 'Create a progression scheme with its ordered ranks. Rank meta is opaque tenant data.',
    handler: async (client, ctx) => {
      const b = ctx.body;
      const positions = new Set();
      for (const r of b.ranks) {
        if (positions.has(r.position)) throw new ApiProblem('validation-error', `Duplicate rank position ${r.position}.`);
        positions.add(r.position);
        checkMeta(r.meta);
      }
      const dup = await client.query('SELECT id FROM progression_scheme WHERE name = $1', [b.name]);
      if (dup.rows.length) throw new ApiProblem('conflict', 'A scheme with this name already exists.');
      const scheme = (await client.query(
        `INSERT INTO progression_scheme (tenant_id, name) VALUES ($1, $2) RETURNING id, name, created_at`,
        [ctx.tenantId, b.name])).rows[0];
      const ranks = [];
      for (const r of [...b.ranks].sort((x, y) => x.position - y.position)) {
        ranks.push((await client.query(
          `INSERT INTO rank (tenant_id, scheme_id, name, position, meta) VALUES ($1, $2, $3, $4, $5)
           RETURNING id, name, position, meta`,
          [ctx.tenantId, scheme.id, r.name, r.position, JSON.stringify(r.meta || {})])).rows[0]);
      }
      return { status: 201, body: { ...scheme, ranks } };
    },
  },
  {
    method: 'GET', path: '/v1/schemes', scope: 'read',
    summary: 'List progression schemes with their ranks (ordered by position).',
    handler: async (client) => {
      const schemes = (await client.query(
        'SELECT id, name, created_at FROM progression_scheme ORDER BY created_at, id')).rows;
      const ranks = (await client.query(
        'SELECT id, scheme_id, name, position, meta FROM rank ORDER BY scheme_id, position')).rows;
      const byScheme = new Map(schemes.map((s) => [s.id, []]));
      for (const r of ranks) if (byScheme.has(r.scheme_id)) byScheme.get(r.scheme_id).push(r);
      return { status: 200, body: { items: schemes.map((s) => ({ ...s, ranks: byScheme.get(s.id) })) } };
    },
  },
  {
    method: 'GET', path: '/v1/schemes/:id', scope: 'read',
    summary: 'Fetch one progression scheme with its ranks.',
    handler: async (client, ctx) => {
      const scheme = await one(client,
        'SELECT id, name, created_at FROM progression_scheme WHERE id = $1', [ctx.params.id]);
      const ranks = (await client.query(
        'SELECT id, scheme_id, name, position, meta FROM rank WHERE scheme_id = $1 ORDER BY position',
        [scheme.id])).rows;
      return { status: 200, body: { ...scheme, ranks } };
    },
  },
  {
    method: 'POST', path: '/v1/ranks/:id/meta', scope: 'admin', schema: S.rankMeta,
    summary: 'Replace the opaque meta object on a rank.',
    handler: async (client, ctx) => {
      checkMeta(ctx.body.meta);
      const rank = await one(client,
        `UPDATE rank SET meta = $2 WHERE id = $1 RETURNING id, scheme_id, name, position, meta`,
        [ctx.params.id, JSON.stringify(ctx.body.meta)]);
      return { status: 200, body: rank };
    },
  },

  // content freshness
  {
    method: 'GET', path: '/v1/content/stale', scope: 'read',
    queryParams: [
      { name: 'days', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 3650 } },
      ...LIST_QUERY_PARAMS,
    ],
    summary: 'Citations whose verified_on is older than `days` (default 180) or missing, with their lesson and course.',
    handler: async (client, ctx) => {
      const days = ctx.query.days === undefined ? 180 : parseInt(ctx.query.days, 10);
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        throw new ApiProblem('validation-error', 'days must be an integer between 1 and 3650.');
      }
      const limit = parseLimit(ctx.query);
      const cur = decodeCursor(ctx.query.cursor);
      const params = cur ? [limit + 1, days, cur.createdAt, cur.id] : [limit + 1, days];
      const where = cur ? 'AND (c.created_at, c.id) > ($3::timestamptz, $4::uuid)' : '';
      const { rows } = await client.query(`
        SELECT c.id, c.lesson_id, l.course_id, l.title AS lesson_title, l.status AS lesson_status,
               c.authority, c.url, c.verified_on,
               CASE WHEN c.verified_on IS NULL THEN NULL
                    ELSE (current_date - c.verified_on)::int END AS days_since_verified,
               c.created_at,
               to_char(c.created_at AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS.US+00') AS cursor_ts
          FROM citation c JOIN lesson l ON l.id = c.lesson_id
         WHERE (c.verified_on IS NULL OR c.verified_on < current_date - ($2::int))
           ${where}
         ORDER BY c.created_at, c.id LIMIT $1`, params);
      return { status: 200, body: { days, ...packPage(rows, limit) } };
    },
  },

  // approvals (append-only record of who signed what)
  {
    method: 'POST', path: '/v1/approvals', scope: 'admin', schema: S.approvalCreate,
    summary: 'Record an approval for a course, lesson or assessment. Append-only; the subject must exist in your tenant.',
    handler: async (client, ctx) => {
      const b = ctx.body;
      if (b.approved_on !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(b.approved_on)) {
        throw new ApiProblem('validation-error', 'approved_on must be YYYY-MM-DD.');
      }
      const table = { course: 'course', lesson: 'lesson', assessment: 'assessment' }[b.subject_kind];
      await one(client, `SELECT id FROM ${table} WHERE id = $1`, [b.subject_id],
        'not-found', `No ${b.subject_kind} with that id.`);
      const row = (await client.query(
        `INSERT INTO approval (tenant_id, subject_kind, subject_id, approver_role, approver_ref, approved_on, note)
         VALUES ($1, $2, $3, $4, $5, coalesce($6::date, current_date), $7)
         RETURNING id, subject_kind, subject_id, approver_role, approver_ref, approved_on, note, created_at`,
        [ctx.tenantId, b.subject_kind, b.subject_id, b.approver_role, b.approver_ref, b.approved_on || null, b.note || ''])).rows[0];
      return { status: 201, body: row };
    },
  },
  {
    method: 'GET', path: '/v1/approvals', scope: 'read',
    queryParams: [
      { name: 'subject_kind', in: 'query', schema: { type: 'string', enum: ['course', 'lesson', 'assessment'] } },
      { name: 'subject_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
      { name: 'approver_role', in: 'query', schema: { type: 'string' } },
      ...LIST_QUERY_PARAMS,
    ],
    summary: 'List approvals, optionally filtered by subject and approver role. Newest first within a subject is up to the caller; order is by creation.',
    handler: async (client, ctx) => {
      const q = ctx.query;
      if (q.subject_kind !== undefined && !['course', 'lesson', 'assessment'].includes(q.subject_kind)) {
        throw new ApiProblem('validation-error', 'subject_kind must be course, lesson or assessment.');
      }
      if (q.subject_id !== undefined && !/^[0-9a-f-]{36}$/i.test(q.subject_id)) {
        throw new ApiProblem('validation-error', 'subject_id must be a uuid.');
      }
      const limit = parseLimit(q);
      const cur = decodeCursor(q.cursor);
      const params = [limit + 1];
      const conds = [];
      if (q.subject_kind) { params.push(q.subject_kind); conds.push(`subject_kind = $${params.length}`); }
      if (q.subject_id) { params.push(q.subject_id); conds.push(`subject_id = $${params.length}::uuid`); }
      if (q.approver_role) { params.push(q.approver_role); conds.push(`approver_role = $${params.length}`); }
      if (cur) {
        params.push(cur.createdAt, cur.id);
        conds.push(`(created_at, id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
      }
      const { rows } = await client.query(`
        SELECT id, subject_kind, subject_id, approver_role, approver_ref, approved_on, note, created_at,
               to_char(created_at AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS.US+00') AS cursor_ts
          FROM approval WHERE true ${conds.map((c) => 'AND ' + c).join(' ')}
         ORDER BY created_at, id LIMIT $1`, params);
      return { status: 200, body: packPage(rows, limit) };
    },
  },
];

async function scoreAndStore(client, attempt, manualPoints = new Map()) {
  const assessment = await one(client,
    'SELECT id, pass_percent FROM assessment WHERE id = $1', [attempt.assessment_id]);
  const items = (await client.query(
    `SELECT id, kind, answer_key, points FROM assessment_item WHERE assessment_id = $1`,
    [assessment.id])).rows;
  const answerRows = (await client.query(
    'SELECT item_id, response FROM attempt_answer WHERE attempt_id = $1', [attempt.id])).rows;
  const answers = new Map(answerRows.map((r) => [r.item_id, r.response]));

  const result = scoreAttempt(items, answers, assessment.pass_percent, manualPoints);
  for (const [itemId, awarded] of result.perItem) {
    if (answers.has(itemId)) {
      await client.query(
        'UPDATE attempt_answer SET points_awarded = $1 WHERE attempt_id = $2 AND item_id = $3',
        [awarded, attempt.id, itemId]);
    }
  }
  const status = result.needsGrading ? 'needs_grading' : 'scored';
  await client.query(
    `UPDATE attempt SET status = $2, submitted_at = coalesce(submitted_at, now()),
            score_percent = $3, passed = $4 WHERE id = $1`,
    [attempt.id, status, result.needsGrading ? null : result.scorePercent, result.passed]);
  return {
    attempt_id: attempt.id,
    status,
    score_percent: result.needsGrading ? null : result.scorePercent,
    passed: result.passed,
    needs_grading: result.needsGrading,
    // per-item outcome, never the key: enough for the learner to see which
    // elements they missed and for the app to point them back to the lesson
    items: items.map((it) => ({
      item_id: it.id,
      points: Number(it.points),
      points_awarded: result.perItem.has(it.id) ? result.perItem.get(it.id) : 0,
      answered: answers.has(it.id),
    })),
  };
}

module.exports = { ROUTES };
