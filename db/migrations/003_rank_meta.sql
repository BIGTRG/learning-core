-- 003_rank_meta.sql — rank meta, approval append-only + indexes (v1.0.1).
-- The core stays vocabulary-neutral: `meta` is an opaque JSON object the
-- tenant's app interprets (e.g. a display colour). No product words here.
ALTER TABLE rank ADD COLUMN meta jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE rank ADD CONSTRAINT rank_meta_is_object CHECK (jsonb_typeof(meta) = 'object');
-- approvals are looked up per subject; latest first
CREATE INDEX IF NOT EXISTS approval_subject_recent_idx ON approval (tenant_id, subject_kind, subject_id, created_at DESC);
-- stale-content scan is by tenant + verified_on
CREATE INDEX IF NOT EXISTS citation_verified_idx ON citation (tenant_id, verified_on);
-- approvals are an append-only record: the app role may insert and read, never rewrite history
REVOKE UPDATE, DELETE ON approval FROM lc_app;
