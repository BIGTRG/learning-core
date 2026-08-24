# Security model — Learning Core

This document exists because a customer's security team will ask. Short answers
first, mechanics after.

## Isolation model

**One database, row-level security, one non-privileged role.**

- Every tenant-owned table has RLS **enabled and forced**. Policies apply to the
  table owner too; there is no code path that reads tenant data without them.
- The application connects exclusively as `lc_app`: `NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOINHERIT NOBYPASSRLS`. Superusers and `BYPASSRLS` roles ignore
  RLS entirely, so `db/roles.sql` ends with a guard that raises if either flag
  is ever set on `lc_app`. The test suite asserts the same from outside.
- Tenant context is set per transaction: `set_config('app.tenant_id', $1, true)`.
  Under PgBouncer transaction pooling the setting dies at the transaction
  boundary — the same boundary at which the connection returns to the pool.
- Every policy is exactly:

  ```sql
  USING (tenant_id = (SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  ```

  `NULLIF(..., '')` because a committed GUC reverts to `''`, not NULL, on a warm
  pooled backend. No context means **zero rows** — fail closed, never an error,
  never a leak. The scalar subquery makes the planner fold the setting to a
  constant once per query instead of once per row (measured 150× difference).
- Cross-tenant reads return **404, not 403**. A 403 confirms the resource
  exists; we do not confirm existence across tenants.

## The one legitimate cross-tenant read

Public credential verification (`GET /v1/verify/:ref`) is an employer with no
API key checking one credential. It is implemented as a single exact-match
`SECURITY DEFINER` SQL function returning only public-page fields. It cannot
enumerate learners or list credentials, and it carries a strict per-IP rate
limit. The app role holds EXECUTE on this function and nothing more.

## API keys

- Format `tenantslug_<40 hex>`; stored as SHA-256 only. The 12-character prefix
  is loggable; the full key never is (a test greps captured log output).
- Comparison is constant-time on the digest.
- Scopes: `read`, `write`, `admin`. Keys carry `expires_at`, `revoked_at`,
  `last_used_at`. Two live keys per tenant make rotation zero-downtime.
- Key lookups are cached in-process for 30 s; revocation publishes a Redis
  pub/sub purge so a revoked key dies immediately across all workers, not after
  30 s multiplied by worker count.

## Data-integrity invariants enforced in the database

- A credential cannot exist without a passing attempt: `BEFORE INSERT` trigger
  on `credential`, independent of any route logic.
- Progress is recomputed from `lesson_progress`; the API accepts completion
  events, never percentages, passes, or ranks.
- Assessment answer keys are never serialized by any endpoint.

## Transport, secrets, operations

- The service binds behind the host ingress; TLS terminates at nginx/Caddy with
  Let's Encrypt once the public domain is assigned.
- No secrets in the repository. Runtime secrets live in `/etc/learning-core/env`
  (mode 600). `db/roles.sql` takes the role password as a `psql -v` variable at
  provision time.
- Structured JSON logs carry `request_id`, tenant slug and key prefix — never
  keys, never learner PII beyond the tenant-supplied display name.
- Nightly Borg backups (encrypted, offsite) including a logical dump of the
  dedicated cluster; restores are exercised, not assumed.

## Reporting

Security reports: admin@trgtechlink.com. Include a request_id where possible.
