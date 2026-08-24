'use strict';
// API keys: `<tenant_slug>_<40 hex>`. Stored as SHA-256 only. The prefix
// (first 12 chars) is safe for logs and UIs; the full key is never logged —
// a test captures log output and fails if a full key appears.

const crypto = require('crypto');
const { withTenant } = require('./db');
const { ApiProblem } = require('./problems');
const config = require('./config');

const cache = new Map(); // hashHex -> { record, at }

// Redis pub/sub purge so revocation is fleet-wide immediate, not 30s * workers.
let subscribed = false;
function subscribeInvalidation(redis) {
  if (subscribed) return;
  subscribed = true;
  const sub = redis.duplicate();
  sub.connect().then(() => {
    sub.subscribe('lc:key_purge', (hashHex) => cache.delete(hashHex));
  }).catch(() => { subscribed = false; });
}

function hashKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey, 'utf8').digest();
}

async function authenticate(req) {
  const header = req.headers.authorization || '';
  const m = header.match(/^Bearer\s+(\S+)$/);
  if (!m) throw new ApiProblem('unauthorized', 'Provide an API key: Authorization: Bearer <key>.');
  const raw = m[1];
  const digest = hashKey(raw);
  const hashHex = digest.toString('hex');

  const hit = cache.get(hashHex);
  if (hit && Date.now() - hit.at < config.keyCacheTtlMs) {
    return checkLiveness(hit.record);
  }

  // Key lookup legitimately runs without tenant context; api_key is not RLS-forced.
  const { rows } = await withTenant(null, (c) => c.query(
    `SELECT k.id, k.tenant_id, k.prefix, k.scopes, k.expires_at, k.revoked_at, k.key_hash,
            t.slug AS tenant_slug, t.rate_limit_per_min
       FROM api_key k JOIN tenant t ON t.id = k.tenant_id
      WHERE k.key_hash = $1`, [digest]
  ));
  if (rows.length === 0) throw new ApiProblem('unauthorized', 'Unknown API key.');
  const record = rows[0];

  // Constant-time comparison of digests (defense in depth beyond the index hit).
  if (!crypto.timingSafeEqual(digest, record.key_hash)) {
    throw new ApiProblem('unauthorized', 'Unknown API key.');
  }
  delete record.key_hash;
  cache.set(hashHex, { record, at: Date.now() });

  // last_used_at fire-and-forget, throttled by the cache TTL.
  withTenant(null, (c) => c.query(
    'UPDATE api_key SET last_used_at = now() WHERE id = $1', [record.id]
  )).catch(() => {});

  return checkLiveness(record);
}

function checkLiveness(record) {
  if (record.revoked_at) throw new ApiProblem('unauthorized', 'This API key has been revoked.');
  if (record.expires_at && new Date(record.expires_at) < new Date()) {
    throw new ApiProblem('unauthorized', 'This API key has expired.');
  }
  return record;
}

function requireScope(auth, scope, method, path) {
  if (!auth.scopes.includes(scope) && !auth.scopes.includes('admin')) {
    throw new ApiProblem('insufficient-scope',
      `This key carries scope '${auth.scopes.join(',')}'; ${method} ${path} requires '${scope}'.`);
  }
}

// Key generation (used by scripts/tenant.js, never exposed as a public endpoint yet).
function generateKey(tenantSlug) {
  const secret = crypto.randomBytes(20).toString('hex');
  const raw = `${tenantSlug}_${secret}`;
  return { raw, prefix: raw.slice(0, 12), hash: hashKey(raw) };
}

async function purgeKey(redis, hashHex) {
  cache.delete(hashHex);
  try { await redis.publish('lc:key_purge', hashHex); } catch (_) {}
}

module.exports = { authenticate, requireScope, generateKey, hashKey, purgeKey, subscribeInvalidation, _cache: cache };
