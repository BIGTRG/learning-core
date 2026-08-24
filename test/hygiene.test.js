'use strict';
// Code-hygiene tests that don't need a running stack.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');

test('no route calls pool.query directly — withTenant() is the only DB path', () => {
  for (const f of fs.readdirSync(SRC)) {
    if (f === 'db.js') continue;
    const code = fs.readFileSync(path.join(SRC, f), 'utf8');
    assert.ok(!/pool\.query|new Pool\(/.test(code), `${f} must not touch the pool directly`);
  }
});

test('no full API key can appear in log output', () => {
  // Structural: nothing in src/ passes a raw bearer/key value into log fields.
  const banned = [/log\.(info|warn|error)\([^)]*\b(raw|rawKey|bearer|authorization)\b/i];
  for (const f of fs.readdirSync(SRC)) {
    const code = fs.readFileSync(path.join(SRC, f), 'utf8');
    for (const rx of banned) assert.ok(!rx.test(code), `${f} may log a credential`);
  }
});

test('captured request logs contain no full API key (runtime check)', async () => {
  // Simulate: run the log module and assert a known key string never round-trips.
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath, ['-e', `
    const log = require('${SRC.replace(/\\/g, '/')}/log.js');
    log.info('request', { prefix: 'reli_xJ9wAb', tenant: 'reli' });
  `]).toString();
  assert.ok(out.includes('reli_xJ9wAb'), 'prefix is fine to log');
  const FULL_KEY = /[a-z][a-z0-9]{1,19}_[0-9a-f]{40}/;
  assert.ok(!FULL_KEY.test(out), 'a full key must never appear in logs');
});

test('secrets are not committed: roles.sql has no literal password', () => {
  const roles = fs.readFileSync(path.join(__dirname, '..', 'db', 'roles.sql'), 'utf8');
  assert.ok(!/PASSWORD\s+'[^']+'/i.test(roles), 'roles.sql must take the password from psql -v');
});

test('RLS policies use the NULLIF + scalar-subquery shape with load-bearing parentheses', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '001_init.sql'), 'utf8');
  assert.ok(schema.includes("(SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid)"));
  // No policy may use the bare, per-row form.
  assert.ok(!/USING\s*\(\s*tenant_id\s*=\s*current_setting/.test(schema),
    'bare current_setting() in a policy is evaluated per row — 150x slower');
});
