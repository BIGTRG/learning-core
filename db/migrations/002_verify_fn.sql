-- 002_verify_fn.sql — public credential verification.
-- The ONLY legitimate cross-tenant read in the system: an employer with no API
-- key checking one credential by exact reference. SECURITY DEFINER, owned by a
-- role that can read across tenants (the function owner), returning only the
-- fields that belong on a public page. It cannot enumerate learners or list
-- credentials. Never grant the app role BYPASSRLS to "make verify work".

CREATE FUNCTION lc_verify(p_ref text)
RETURNS TABLE (
  public_ref    text,
  status        text,
  learner_name  text,
  course_title  text,
  rank_name     text,
  issuer        text,
  issued_at     timestamptz,
  revoked_at    timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $fn$
  SELECT c.public_ref, c.status, l.display_name, co.title, r.name, t.name,
         c.issued_at, c.revoked_at
    FROM credential c
    JOIN learner l  ON l.id  = c.learner_id
    JOIN course co  ON co.id = c.course_id
    JOIN tenant t   ON t.id  = c.tenant_id
    LEFT JOIN rank r ON r.id = co.rank_id
   WHERE c.public_ref = p_ref;
$fn$;

-- exact-match only; the unique index on credential.public_ref serves it.
REVOKE ALL ON FUNCTION lc_verify(text) FROM PUBLIC;
