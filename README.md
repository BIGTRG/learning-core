# Learning Core

Headless, multi-tenant learning API. Structured course content, recomputed
progress, server-side scoring with partial credit, publicly verifiable
credentials, metered usage. No UI, ever — every consumer is a front end calling
over HTTP with a Bearer key.

Owner: Robinson Family Trust · Operator: Robinson Employment Institute, LLC.
RELI is customer #1 of this API and is never a special case.

## The two bugs that shaped this codebase

Documented so they are not reintroduced:

1. **The decorative-RLS bug.** V1 connected as `postgres`. Superusers bypass
   RLS, so every isolation policy was silently inert and every test passed
   anyway. The app role is `lc_app` (no superuser, no BYPASSRLS) and
   `db/roles.sql` + the test suite both fail hard if that changes.
2. **The warm-pool GUC bug.** After commit, a custom GUC reverts to `''` — not
   NULL — so warm and cold pooled backends behave differently. Every policy uses
   `NULLIF(current_setting('app.tenant_id', true), '')::uuid` wrapped in a
   scalar subquery. The parentheses are load-bearing: the bare call is evaluated
   per row and was measured 150× slower. Do not clean them up.

A third one found during this build: encoding pagination cursors from
`Date#toISOString()` truncates Postgres microseconds and repeats the boundary
row on the next page. Cursors are encoded from microsecond-precise text.

## Layout

```
db/migrations/   001 schema (23 tables, RLS forced on 20) · 002 verify fn
db/roles.sql     lc_app role + guard (password via psql -v, never committed)
src/             zero-framework node:http API — see src/routes.js for the table
scripts/         migrate · tenant/key admin · seed · usage rollup · idempotency sweep
test/            27 tests, run against the deployed stack
openapi.json     generated: npm run openapi > openapi.json (CI-checked)
```

## Running

```
npm install
node scripts/migrate.js                 # as a privileged PG user, direct :5433
psql -p 5433 -d learning_core -v app_password='<secret>' -f db/roles.sql
node src/server.js                      # reads /etc/learning-core/env
npm test                                # needs TEST_BASE_URL + MIGRATE_* env
```

Production: PM2 (`ecosystem.config.cjs`, cluster ×2) on ge-api-engine, dedicated
PostgreSQL 16 cluster on :5433 behind PgBouncer :6432 (transaction mode, pool 25,
max_client_conn 2000, max_connections 120), dedicated Redis :6380.

## Using the API

Spec: `GET /v1/openapi.json` (OpenAPI 3.1, generated from the route table).
Postman collection: `docs/postman_collection.json`. One-line examples:

```bash
B=https://<host>; K=<your api key>
curl -s $B/v1/courses -H "Authorization: Bearer $K"
curl -s $B/v1/learners -X POST -H "Authorization: Bearer $K" -H "Content-Type: application/json" \
     -H "Idempotency-Key: create-maria-1" \
     -d '{"external_ref":"user-42","display_name":"Maria Alvarez"}'
curl -s $B/v1/enrollments -X POST -H "Authorization: Bearer $K" -H "Content-Type: application/json" \
     -d '{"learner_id":"<uuid>","course_id":"<uuid>"}'
curl -s $B/v1/enrollments/<id>/lessons/<lesson_id>/complete -X POST -H "Authorization: Bearer $K"
curl -s $B/v1/attempts -X POST -H "Authorization: Bearer $K" -H "Content-Type: application/json" \
     -d '{"enrollment_id":"<uuid>","assessment_id":"<uuid>"}'
curl -s $B/v1/attempts/<id>/submit -X POST -H "Authorization: Bearer $K"
curl -s $B/v1/credentials -X POST -H "Authorization: Bearer $K" -H "Content-Type: application/json" \
     -d '{"attempt_id":"<uuid>"}'
curl -s $B/v1/verify/LC-XXXX-XXXX-XXXX-XX          # public, no key
curl -s "$B/v1/usage?from=2026-08-01&to=2026-08-31" -H "Authorization: Bearer $K"
```

Conventions: errors are RFC 9457 `application/problem+json` with resolving
`type` URLs; every POST accepts `Idempotency-Key` (Stripe semantics); lists use
cursor pagination (`limit` ≤ 200, opaque `cursor`); every response carries
`X-RateLimit-*` headers and `X-Request-Id`.

## Vocabulary rule

The core says `rank`, `progression_scheme`, `competency_tag`, `assessment_item`,
`approval`, `citation.verified_on`. Product words (belts, stamps, dojos,
advisors) live in the consuming apps. A test greps `information_schema` and
fails the build if banned vocabulary reaches a table or column name.

## Operations

- Backups: nightly Borg to the storagebox (`/opt/borgbackup/run-backup.sh`),
  including a `pg_dumpall` of the :5433 cluster; restore procedure verified.
- Nightly `scripts/usage_rollup.js` aggregates `usage_event` → `usage_daily`
  and pushes Stripe Billing Meter events (API pinned `2026-07-29.dahlia`;
  the removed `usage_records` API is never used). Push is idempotent.
- `scripts/sweep_idempotency.js` clears idempotency keys older than 48 h.
- Tenant admin: `scripts/tenant.js create|key|revoke` (privileged, prints a key
  once, publishes revocation purges).
