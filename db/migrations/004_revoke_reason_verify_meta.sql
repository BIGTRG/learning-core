-- 004_revoke_reason_verify_meta.sql — credential revocation reason + rank meta on verify (v1.0.4).
-- Revocation is one-way: the row keeps status='revoked', revoked_at and the
-- reason forever. The public verify record carries the reason and the rank's
-- opaque meta (the consuming app maps meta to presentation, never by rank name).
ALTER TABLE credential ADD COLUMN revoke_reason text;
ALTER TABLE credential ADD CONSTRAINT credential_revoked_consistent
  CHECK ((status = 'active' AND revoked_at IS NULL AND revoke_reason IS NULL)
      OR (status = 'revoked' AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL));

-- Once revoked, a credential never becomes active again — enforced in the database,
-- not only in the route handler.
CREATE OR REPLACE FUNCTION lc_credential_one_way_revoke() RETURNS trigger
LANGUAGE plpgsql AS $t$
BEGIN
  IF OLD.status = 'revoked' AND (NEW.status <> 'revoked'
      OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
      OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason) THEN
    RAISE EXCEPTION 'credential % is revoked; revocation is permanent', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$t$;
CREATE TRIGGER credential_one_way_revoke BEFORE UPDATE ON credential
  FOR EACH ROW EXECUTE FUNCTION lc_credential_one_way_revoke();

-- lc_verify: return type changes, so drop and recreate (grants re-applied below).
DROP FUNCTION lc_verify(text);
CREATE FUNCTION lc_verify(p_ref text)
RETURNS TABLE (
  public_ref    text,
  status        text,
  learner_name  text,
  course_title  text,
  rank_name     text,
  rank_meta     jsonb,
  issuer        text,
  issued_at     timestamptz,
  revoked_at    timestamptz,
  revoke_reason text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $fn$
  SELECT c.public_ref, c.status, l.display_name, co.title, r.name,
         COALESCE(r.meta, '{}'::jsonb), t.name,
         c.issued_at, c.revoked_at, c.revoke_reason
    FROM credential c
    JOIN learner l  ON l.id  = c.learner_id
    JOIN course co  ON co.id = c.course_id
    JOIN tenant t   ON t.id  = c.tenant_id
    LEFT JOIN rank r ON r.id = co.rank_id
   WHERE c.public_ref = p_ref;
$fn$;
REVOKE ALL ON FUNCTION lc_verify(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lc_verify(text) TO lc_app;
