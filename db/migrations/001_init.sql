-- 001_init.sql — Learning Core schema.
-- Every tenant-owned table: RLS ENABLED and FORCED, policy in the exact
-- NULLIF + scalar-subquery shape (see README: the parentheses are load-bearing),
-- and a composite index leading with tenant_id.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- global tables (no tenant_id, no RLS) ----------

CREATE TABLE tenant (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9]{1,19}$'),
  name        text NOT NULL,
  rate_limit_per_min integer NOT NULL DEFAULT 1000,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_key (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  prefix      text NOT NULL,                -- first 12 chars, safe to log
  key_hash    bytea NOT NULL UNIQUE,        -- sha256 of the full key
  scopes      text[] NOT NULL DEFAULT '{read}',
  expires_at  timestamptz,
  revoked_at  timestamptz,
  last_used_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_key_tenant_idx ON api_key (tenant_id, created_at);

-- ---------- tenant-owned tables ----------

CREATE TABLE progression_scheme (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE rank (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  scheme_id   uuid NOT NULL REFERENCES progression_scheme(id),
  name        text NOT NULL,
  position    integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, scheme_id, position)
);

CREATE TABLE competency_tag (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  code        text NOT NULL,
  label       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE course (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  scheme_id   uuid REFERENCES progression_scheme(id),
  rank_id     uuid REFERENCES rank(id),
  title       text NOT NULL,
  summary     text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE course_module (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  course_id   uuid NOT NULL REFERENCES course(id),
  title       text NOT NULL,
  position    integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, course_id, position)
);

CREATE TABLE lesson (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  course_id   uuid NOT NULL REFERENCES course(id),
  module_id   uuid REFERENCES course_module(id),
  title       text NOT NULL,
  summary     text NOT NULL DEFAULT '',
  position    integer NOT NULL,
  est_minutes integer,
  blocks      jsonb NOT NULL DEFAULT '[]',   -- typed blocks, never markup
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, course_id, position)
);

CREATE TABLE citation (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  lesson_id    uuid NOT NULL REFERENCES lesson(id),
  authority    text NOT NULL,
  url          text,
  verified_on  date,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE assessment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  course_id    uuid NOT NULL REFERENCES course(id),
  title        text NOT NULL,
  pass_percent numeric NOT NULL DEFAULT 80 CHECK (pass_percent > 0 AND pass_percent <= 100),
  time_limit_minutes integer,
  max_attempts integer,
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE assessment_item (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  assessment_id uuid NOT NULL REFERENCES assessment(id),
  position     integer NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('single','multi','constructed')),
  prompt       jsonb NOT NULL,               -- typed blocks
  options      jsonb NOT NULL DEFAULT '[]',  -- [{id,text}] for single/multi
  answer_key   jsonb NOT NULL DEFAULT '[]',  -- option ids; never returned by any endpoint
  points       numeric NOT NULL DEFAULT 1 CHECK (points > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, assessment_id, position)
);

CREATE TABLE learner (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  external_ref text NOT NULL,                -- the app's own user id
  display_name text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_ref)
);

CREATE TABLE enrollment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  learner_id   uuid NOT NULL REFERENCES learner(id),
  course_id    uuid NOT NULL REFERENCES course(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, learner_id, course_id)
);

CREATE TABLE lesson_progress (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  enrollment_id uuid NOT NULL REFERENCES enrollment(id),
  lesson_id    uuid NOT NULL REFERENCES lesson(id),
  completed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, enrollment_id, lesson_id)
);

CREATE TABLE attempt (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  enrollment_id uuid NOT NULL REFERENCES enrollment(id),
  assessment_id uuid NOT NULL REFERENCES assessment(id),
  status       text NOT NULL DEFAULT 'in_progress'
               CHECK (status IN ('in_progress','submitted','needs_grading','scored')),
  started_at   timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  score_percent numeric,
  passed       boolean,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE attempt_answer (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  attempt_id   uuid NOT NULL REFERENCES attempt(id),
  item_id      uuid NOT NULL REFERENCES assessment_item(id),
  response     jsonb NOT NULL,               -- option ids or constructed text
  points_awarded numeric,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, attempt_id, item_id)
);

CREATE TABLE credential (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  learner_id   uuid NOT NULL REFERENCES learner(id),
  course_id    uuid NOT NULL REFERENCES course(id),
  attempt_id   uuid NOT NULL REFERENCES attempt(id),
  public_ref   text NOT NULL UNIQUE,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  issued_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE credential_tag (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  credential_id uuid NOT NULL REFERENCES credential(id),
  tag_id        uuid NOT NULL REFERENCES competency_tag(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, credential_id, tag_id)
);

CREATE TABLE approval (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  subject_kind text NOT NULL CHECK (subject_kind IN ('course','lesson','assessment')),
  subject_id   uuid NOT NULL,
  approver_role text NOT NULL,
  approver_ref text NOT NULL,
  approved_on  date NOT NULL DEFAULT current_date,
  note         text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_key (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  key          text NOT NULL,
  fingerprint  text NOT NULL,                -- sha256(method + path + body)
  status       text NOT NULL DEFAULT 'in_flight' CHECK (status IN ('in_flight','done')),
  response_status integer,
  response_body   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

CREATE TABLE usage_event (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  kind         text NOT NULL CHECK (kind IN ('api_call','learner_active')),
  subject_ref  text,                          -- endpoint or learner id
  occurred_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usage_daily (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  day          date NOT NULL,
  api_calls    bigint NOT NULL DEFAULT 0,
  active_learners bigint NOT NULL DEFAULT 0,
  pushed_at    timestamptz,                   -- when sent to billing; idempotent re-push
  UNIQUE (tenant_id, day)
);

-- ---------- RLS: enable + force + policy, identical shape everywhere ----------

DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'progression_scheme','rank','competency_tag','course','course_module',
    'lesson','citation','assessment','assessment_item','learner','enrollment',
    'lesson_progress','attempt','attempt_answer','credential','credential_tag',
    'approval','idempotency_key','usage_event','usage_daily'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING      (tenant_id = (SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid))
        WITH CHECK (tenant_id = (SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid))
    $p$, t);
  END LOOP;
END
$rls$;

-- ---------- composite indexes, tenant_id leading ----------

CREATE INDEX scheme_tenant_idx      ON progression_scheme (tenant_id, created_at, id);
CREATE INDEX rank_tenant_idx        ON rank (tenant_id, scheme_id, position);
CREATE INDEX tag_tenant_idx         ON competency_tag (tenant_id, code);
CREATE INDEX course_tenant_idx      ON course (tenant_id, created_at, id);
CREATE INDEX module_tenant_idx      ON course_module (tenant_id, course_id, position);
CREATE INDEX lesson_tenant_idx      ON lesson (tenant_id, course_id, position);
CREATE INDEX citation_tenant_idx    ON citation (tenant_id, lesson_id);
CREATE INDEX assessment_tenant_idx  ON assessment (tenant_id, course_id);
CREATE INDEX item_tenant_idx        ON assessment_item (tenant_id, assessment_id, position);
CREATE INDEX learner_tenant_idx     ON learner (tenant_id, created_at, id);
CREATE INDEX enrollment_tenant_idx  ON enrollment (tenant_id, learner_id);
CREATE INDEX enrollment_course_idx  ON enrollment (tenant_id, course_id);
CREATE INDEX progress_tenant_idx    ON lesson_progress (tenant_id, enrollment_id);
CREATE INDEX attempt_tenant_idx     ON attempt (tenant_id, enrollment_id, created_at);
CREATE INDEX answer_tenant_idx      ON attempt_answer (tenant_id, attempt_id);
CREATE INDEX credential_tenant_idx  ON credential (tenant_id, learner_id);
CREATE INDEX credtag_tenant_idx     ON credential_tag (tenant_id, credential_id);
CREATE INDEX approval_tenant_idx    ON approval (tenant_id, subject_kind, subject_id);
CREATE INDEX idem_tenant_idx        ON idempotency_key (tenant_id, key);
CREATE INDEX idem_sweep_idx         ON idempotency_key (created_at);
CREATE INDEX usage_event_idx        ON usage_event (tenant_id, occurred_at);
CREATE INDEX usage_daily_idx        ON usage_daily (tenant_id, day);

-- ---------- DB-enforced invariant: credential requires a passing attempt ----------

CREATE FUNCTION credential_requires_pass() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE ok boolean;
BEGIN
  SELECT a.passed INTO ok FROM attempt a
   WHERE a.id = NEW.attempt_id AND a.tenant_id = NEW.tenant_id;
  IF ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'credential requires a passing attempt on record'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER credential_pass_guard
  BEFORE INSERT ON credential
  FOR EACH ROW EXECUTE FUNCTION credential_requires_pass();
