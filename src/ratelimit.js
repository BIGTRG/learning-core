'use strict';
// Sliding-window rate limiting in Redis, keyed by API key id (never by IP —
// customers sit behind NAT), except the public verify endpoint which is per-IP.
// Headers are the GitHub-style ones the market reads today.

const { createClient } = require('redis');
const config = require('./config');
const log = require('./log');

let redis = null;
async function getRedis() {
  if (redis) return redis;
  redis = createClient({ socket: { host: config.redis.host, port: config.redis.port } });
  redis.on('error', (e) => log.warn('redis error', { err: String(e.message) }));
  await redis.connect();
  return redis;
}

/**
 * Sliding window over two fixed 60s buckets (weighted). Returns
 * { allowed, limit, remaining, resetEpoch, retryAfter }.
 */
async function check(bucketKey, limitPerMin) {
  const r = await getRedis();
  const now = Date.now();
  const windowMs = 60_000;
  const cur = Math.floor(now / windowMs);
  const curKey = `rl:${bucketKey}:${cur}`;
  const prevKey = `rl:${bucketKey}:${cur - 1}`;

  const multi = r.multi();
  multi.incr(curKey);
  multi.expire(curKey, 130);
  multi.get(prevKey);
  const [curCount, , prevCountRaw] = await multi.exec();
  const prevCount = parseInt(prevCountRaw || '0', 10);
  const elapsed = (now % windowMs) / windowMs;
  const used = prevCount * (1 - elapsed) + Number(curCount);

  const resetEpoch = Math.ceil(((cur + 1) * windowMs) / 1000);
  const remaining = Math.max(0, Math.floor(limitPerMin - used));
  const allowed = used <= limitPerMin;
  return {
    allowed, limit: limitPerMin, remaining, resetEpoch,
    retryAfter: allowed ? 0 : Math.max(1, resetEpoch - Math.floor(now / 1000)),
  };
}

module.exports = { check, getRedis };
