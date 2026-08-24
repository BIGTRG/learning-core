'use strict';
// RFC 9457 Problem Details. Every non-2xx response is application/problem+json.
// Every `type` URL resolves to a real hosted page (src/routes.js serves
// /problems/:slug). Never a tenant's data, a key, or a stack trace in detail.

const config = require('./config');

const CATALOG = {
  'validation-error':      { status: 422, title: 'Validation error' },
  'not-found':             { status: 404, title: 'Not found' },
  'unauthorized':          { status: 401, title: 'Unauthorized' },
  'insufficient-scope':    { status: 403, title: 'Insufficient scope' },
  'rate-limited':          { status: 429, title: 'Too many requests' },
  'idempotency-mismatch':  { status: 422, title: 'Idempotency key reuse with a different request' },
  'idempotency-in-flight': { status: 409, title: 'A request with this idempotency key is still in flight' },
  'conflict':              { status: 409, title: 'Conflict' },
  'invariant-violation':   { status: 409, title: 'Invariant violation' },
  'internal':              { status: 500, title: 'Internal error' },
};

function problem(slug, detail, instance, requestId, extra = {}) {
  const c = CATALOG[slug] || CATALOG.internal;
  return {
    status: c.status,
    body: {
      type: `${config.publicBaseUrl}/problems/${slug}`,
      title: c.title,
      status: c.status,
      detail: detail || c.title,
      instance,
      request_id: requestId,
      ...extra,
    },
  };
}

// Thrown by handlers, caught by the router.
class ApiProblem extends Error {
  constructor(slug, detail, extra = {}) {
    super(detail || slug);
    this.slug = slug;
    this.extra = extra;
  }
}

module.exports = { problem, ApiProblem, CATALOG };
