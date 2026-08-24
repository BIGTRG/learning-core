'use strict';
// Zero-framework node:http server. Request lifecycle:
//   request_id -> route match -> (public? per-IP limit : auth -> per-key limit)
//   -> body parse + schema check -> ONE tenant transaction (idempotency begin,
//   handler, idempotency finish) -> usage metering -> RFC 9457 on any failure.

const http = require('http');
const crypto = require('crypto');
const config = require('./config');
const log = require('./log');
const { withTenant, ping } = require('./db');
const { authenticate, requireScope, subscribeInvalidation } = require('./auth');
const { problem, ApiProblem, CATALOG } = require('./problems');
const rateLimit = require('./ratelimit');
const idem = require('./idempotency');
const usage = require('./usage');
const { ROUTES } = require('./routes');
const { check } = require('./validate');
const openapi = require('./openapi');

const MAX_BODY = 1_048_576; // 1 MiB

// ---------- route matching ----------

function compile(route) {
  const names = [];
  const rx = new RegExp('^' + route.path.replace(/:[A-Za-z]+/g, (m) => {
    names.push(m.slice(1));
    return '([^/]+)';
  }) + '$');
  return { ...route, rx, names };
}
const COMPILED = ROUTES.map(compile);

function match(method, pathname) {
  for (const r of COMPILED) {
    if (r.method !== method) continue;
    const m = r.rx.exec(pathname);
    if (m) {
      const params = {};
      r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
  }
  return null;
}

// ---------- responses ----------

function send(res, status, body, headers = {}) {
  const isProblem = status >= 400;
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': isProblem ? 'application/problem+json' : 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function sendProblem(res, slug, detail, instance, requestId, headers = {}, extra = {}) {
  const p = problem(slug, detail, instance, requestId, extra);
  send(res, p.status, p.body, headers);
}

// ---------- problem type pages (every `type` URL resolves) ----------

const PROBLEM_PAGE = (slug, c) => `<!DOCTYPE html><html><head><title>${c.title}</title></head>
<body style="font-family:sans-serif;max-width:640px;margin:40px auto;line-height:1.6">
<h1>${c.title} (${c.status})</h1>
<p>Problem type <code>${slug}</code> from the Learning Core API.</p>
<p>Errors follow RFC 9457 Problem Details. The <code>detail</code> member of the
response explains the specific failure; <code>request_id</code> identifies the
request for support.</p>
<p><a href="/v1/openapi.json">OpenAPI specification</a></p></body></html>`;

// ---------- request body ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new ApiProblem('validation-error', 'Request body exceeds 1 MiB.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------- RED metrics (per endpoint per tenant, exposed in logs) ----------

const red = new Map();
function redRecord(routePath, tenantSlug, status, ms) {
  const k = `${routePath}|${tenantSlug || '-'}`;
  const m = red.get(k) || { count: 0, errors: 0, totalMs: 0 };
  m.count++; if (status >= 500) m.errors++; m.totalMs += ms;
  red.set(k, m);
}
setInterval(() => {
  for (const [k, m] of red) {
    const [route, tenant] = k.split('|');
    log.info('red_metrics', { route, tenant, count: m.count, errors: m.errors, avg_ms: Math.round(m.totalMs / m.count) });
  }
  red.clear();
}, 60_000).unref();

// ---------- main handler ----------

async function handle(req, res) {
  const started = Date.now();
  const requestId = crypto.randomUUID();
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  res.setHeader('X-Request-Id', requestId);

  let tenantSlug = null;
  let routePath = pathname;
  try {
    // meta endpoints
    if (req.method === 'GET' && pathname === '/v1/health') return send(res, 200, { status: 'alive' });
    if (req.method === 'GET' && pathname === '/v1/ready') {
      try {
        await ping();
        await (await rateLimit.getRedis()).ping();
        return send(res, 200, { status: 'ready' });
      } catch (e) {
        return send(res, 503, { status: 'not_ready' });
      }
    }
    if (req.method === 'GET' && pathname === '/v1/openapi.json') {
      return send(res, 200, openapi.generate());
    }
    const pm = pathname.match(/^\/problems\/([a-z-]+)$/);
    if (req.method === 'GET' && pm) {
      const c = CATALOG[pm[1]];
      if (!c) return sendProblem(res, 'not-found', 'Unknown problem type.', pathname, requestId);
      const html = PROBLEM_PAGE(pm[1], c);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // public verify — per-IP strict limit, no auth
    const vm = pathname.match(/^\/v1\/verify\/([A-Za-z0-9-]+)$/);
    if (req.method === 'GET' && vm) {
      routePath = '/v1/verify/:ref';
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const rl = await rateLimit.check(`verify:${ip}`, config.rateLimit.verifyPerIpPerMin);
      setRateHeaders(res, rl);
      if (!rl.allowed) {
        res.setHeader('Retry-After', String(rl.retryAfter));
        return sendProblem(res, 'rate-limited', 'Verification is rate limited per IP. Slow down.', pathname, requestId);
      }
      const { rows } = await withTenant(null, (c) => c.query('SELECT * FROM lc_verify($1)', [vm[1]]));
      if (rows.length === 0) return sendProblem(res, 'not-found', 'No credential with that reference.', pathname, requestId);
      return send(res, 200, rows[0]);
    }

    // authenticated routes
    const matched = match(req.method, pathname);
    if (!matched) return sendProblem(res, 'not-found', 'No such endpoint.', pathname, requestId);
    const { route, params } = matched;
    routePath = route.path;

    const auth = await authenticate(req);
    tenantSlug = auth.tenant_slug;
    requireScope(auth, route.scope, req.method, pathname);

    const rl = await rateLimit.check(`key:${auth.id}`, auth.rate_limit_per_min || config.rateLimit.defaultPerMin);
    setRateHeaders(res, rl);
    if (!rl.allowed) {
      res.setHeader('Retry-After', String(rl.retryAfter));
      return sendProblem(res, 'rate-limited', 'Rate limit exceeded for this API key.', pathname, requestId);
    }

    // body
    let bodyRaw = '';
    let body = undefined;
    if (req.method === 'POST') {
      bodyRaw = await readBody(req);
      if (route.schema) {
        try { body = bodyRaw ? JSON.parse(bodyRaw) : {}; }
        catch (_) { throw new ApiProblem('validation-error', 'Request body is not valid JSON.'); }
        check(body, route.schema);
      }
    }

    const idemKey = req.method === 'POST' ? (req.headers['idempotency-key'] || null) : null;
    const fp = idemKey ? idem.fingerprint(req.method, pathname, bodyRaw) : null;

    const ctx = {
      tenantId: auth.tenant_id, tenantSlug, params, body,
      query: Object.fromEntries(url.searchParams), requestId, learnerActive: false,
    };

    const out = await withTenant(auth.tenant_id, async (client) => {
      const idemState = await idem.begin(client, auth.tenant_id, idemKey, fp);
      if (idemState && idemState.replay) return { replay: true, ...idemState.replay };
      const result = await route.handler(client, ctx);
      if (idemState && idemState.record) {
        await idem.finish(client, idemState.record.id, result.status, JSON.stringify(result.body));
      }
      return result;
    });

    // usage metering
    usage.record(auth.tenant_id, 'api_call', routePath);
    if (ctx.learnerActive) usage.record(auth.tenant_id, 'learner_active', extractLearnerRef(ctx));

    if (out.replay) {
      res.setHeader('Idempotent-Replay', 'true');
      return send(res, out.status, out.body); // stored string, byte-identical
    }
    return send(res, out.status, out.body);
  } catch (err) {
    if (err instanceof ApiProblem) {
      return sendProblem(res, err.slug, err.message, pathname, requestId, {}, err.extra);
    }
    log.error('unhandled', { request_id: requestId, path: pathname, err: String(err.message) });
    return sendProblem(res, 'internal', 'An internal error occurred. Quote the request_id to support.', pathname, requestId);
  } finally {
    const ms = Date.now() - started;
    redRecord(routePath, tenantSlug, res.statusCode, ms);
    log.info('request', {
      request_id: requestId, method: req.method, path: pathname,
      status: res.statusCode, ms, tenant: tenantSlug,
    });
  }
}

function setRateHeaders(res, rl) {
  res.setHeader('X-RateLimit-Limit', String(rl.limit));
  res.setHeader('X-RateLimit-Remaining', String(rl.remaining));
  res.setHeader('X-RateLimit-Reset', String(rl.resetEpoch));
}

function extractLearnerRef(ctx) {
  return (ctx.body && ctx.body.learner_id) || (ctx.params && (ctx.params.id || ctx.params.lessonId)) || null;
}

// ---------- boot ----------

async function main() {
  usage.start();
  try { subscribeInvalidation(await rateLimit.getRedis()); } catch (_) {}
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log.error('handler crash', { err: String(e && e.message) });
      try { send(res, 500, { title: 'Internal error', status: 500 }); } catch (_) {}
    });
  });
  server.listen(config.port, config.listenHost, () => {
    log.info('listening', { port: config.port, env: config.env });
  });
  const shutdown = async () => {
    server.close();
    await usage.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();
module.exports = { handle };
