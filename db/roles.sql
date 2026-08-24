-- roles.sql — the application role. Run as superuser at provision time:
--   psql -v app_password='<secret>' -f db/roles.sql
-- The password comes from the environment at provision time. It is NEVER
-- committed to this repository.
-- NOTE: psql variables do not interpolate inside dollar-quoted blocks, which is
-- why creation uses \gexec and the password is set in a top-level ALTER.

SELECT 'CREATE ROLE lc_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lc_app') \gexec

ALTER ROLE lc_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS
  PASSWORD :'app_password';

GRANT USAGE ON SCHEMA public TO lc_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO lc_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lc_app;
GRANT EXECUTE ON FUNCTION lc_verify(text) TO lc_app;

-- Guard: if lc_app is ever a superuser or gains BYPASSRLS, every isolation
-- policy in this system is silently decorative. Fail loudly. Run this in CI.
DO $$
DECLARE r pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO r FROM pg_roles WHERE rolname = 'lc_app';
  IF r.rolsuper THEN
    RAISE EXCEPTION 'lc_app must never be SUPERUSER';
  END IF;
  IF r.rolbypassrls THEN
    RAISE EXCEPTION 'lc_app must never have BYPASSRLS';
  END IF;
END $$;
