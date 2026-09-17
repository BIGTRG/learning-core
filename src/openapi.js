'use strict';
// OpenAPI 3.1 generated from the route table — the spec cannot drift from the
// code. CI fails if the committed openapi.json differs from this output.

const { ROUTES } = require('./routes');
const config = require('./config');
const pkg = require('../package.json');

function pathToOpenApi(p) {
  return p.replace(/:([A-Za-z]+)/g, '{$1}');
}

function pathParams(p) {
  const out = [];
  for (const m of p.matchAll(/:([A-Za-z]+)/g)) {
    out.push({
      name: m[1], in: 'path', required: true,
      schema: { type: 'string', format: 'uuid' },
    });
  }
  return out;
}

function generate() {
  const paths = {};
  for (const r of ROUTES) {
    const oaPath = pathToOpenApi(r.path);
    paths[oaPath] = paths[oaPath] || {};
    const op = {
      summary: r.summary || '',
      operationId: `${r.method.toLowerCase()}_${r.path.replace(/[/:]+/g, '_').replace(/^_|_$/g, '')}`,
      security: [{ apiKey: [] }],
      parameters: [...pathParams(r.path), ...(r.queryParams || [])],
      responses: {
        default: {
          description: 'Errors are RFC 9457 Problem Details (application/problem+json).',
          content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
        },
        '2XX': {
          description: 'Success',
          content: { 'application/json': { schema: { type: 'object' } } },
        },
      },
    };
    if (r.schema) {
      op.requestBody = {
        required: true,
        content: { 'application/json': { schema: r.schema } },
      };
    }
    if (r.method === 'POST') {
      op.parameters.push({
        name: 'Idempotency-Key', in: 'header', required: false,
        description: 'Stripe-semantics idempotency: replays return the stored response byte-identical with Idempotent-Replay: true; reuse with a different request is a 422; in-flight is a 409. Retained 24h.',
        schema: { type: 'string', maxLength: 255 },
      });
    }
    paths[oaPath][r.method.toLowerCase()] = op;
  }

  // Public + meta endpoints not in the auth'd table.
  paths['/v1/verify/{ref}'] = {
    get: {
      summary: 'Public credential verification. No API key. Exact-match only; strictly rate limited per IP. Fields: public_ref, status (active|revoked), learner_name, course_title, rank_name, rank_meta (opaque tenant JSON, e.g. a display colour), issuer, issued_at, revoked_at, revoke_reason.',
      operationId: 'get_v1_verify_ref',
      security: [],
      parameters: [{ name: 'ref', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'The credential public record.', content: { 'application/json': { schema: { type: 'object' } } } },
        default: { description: 'Problem Details', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
      },
    },
  };
  paths['/v1/health'] = { get: { summary: 'Liveness (no dependencies).', operationId: 'get_v1_health', security: [], responses: { 200: { description: 'alive' } } } };
  paths['/v1/ready'] = { get: { summary: 'Readiness (checks Postgres and Redis).', operationId: 'get_v1_ready', security: [], responses: { 200: { description: 'ready' }, 503: { description: 'not ready' } } } };

  return {
    openapi: '3.1.0',
    info: {
      title: 'Learning Core API',
      version: pkg.version,
      description: 'Headless multi-tenant learning API: structured course content, recomputed progress, server-side scoring with partial credit, publicly verifiable credentials, and metered usage. Content is typed JSON blocks, never markup.',
    },
    servers: [{ url: config.publicBaseUrl }],
    paths,
    components: {
      securitySchemes: {
        apiKey: { type: 'http', scheme: 'bearer', description: 'Tenant API key, e.g. reli_xJ9w… Scopes: read, write, admin.' },
      },
      schemas: {
        Problem: {
          type: 'object',
          description: 'RFC 9457 Problem Details. Every type URL resolves to a hosted page.',
          required: ['type', 'title', 'status'],
          properties: {
            type: { type: 'string', format: 'uri' },
            title: { type: 'string' },
            status: { type: 'integer' },
            detail: { type: 'string' },
            instance: { type: 'string' },
            request_id: { type: 'string' },
          },
        },
      },
    },
  };
}

module.exports = { generate };
