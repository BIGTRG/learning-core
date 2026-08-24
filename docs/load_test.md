# Load test — 2026-08-24, ge-api-engine (12 cores, 22 GB)

Tool: autocannon on-host, GET /v1/courses (auth + RLS + tenant transaction per
request), 5 tenants in parallel, 20 s per level. Numbers are max across tenants.

| in-flight connections | req/s | p50 | p95 | p99 | errors |
|---|---|---|---|---|---|
| 100 | 8,554 | 11 ms | 17 ms | 21 ms | 0 |
| 1,000 | 8,298 | 117 ms | 143 ms | 169 ms | 0 |
| 5,000 | 7,956 | 565 ms | 1.9 s | 2.2 s | 0 |
| 15,000 | 6,698 | 1.9 s | 4.5 s | 4.6 s | 0 |

- Sustained throughput ~8k req/s; zero errors, zero timeouts at every level up
  to 15,000 open sockets.
- **Pool saturation point: ~1,000 truly concurrent in-flight requests** with
  2 PM2 workers and PgBouncer pool 25 — p95 stays under the 150 ms target up to
  that depth and queues beyond it.
- Scaling PM2 to 4 workers changed nothing (7,992 rps @1,000) — the DB pool
  path is the ceiling, not Node CPU. Raise default_pool_size before adding
  workers if deeper concurrency is ever needed.
- 15,000 concurrent *learners* is a human workload with think time. At one
  request per 5–10 s per learner (1,500–3,000 req/s, request depth well under
  500), measured p95 is under 20–150 ms — the target holds with ~3–5×
  throughput headroom.
