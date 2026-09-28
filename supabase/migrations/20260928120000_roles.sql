-- App role and migration role.
--
-- skyway_app is what API handlers will connect as. It cannot bypass row-level
-- security. skyway_migration is the backfill role (BYPASSRLS). No file under
-- api/ may connect as skyway_migration.
--
-- skyway_owner owns the tables. FORCE ROW LEVEL SECURITY still applies to it,
-- so a connection that is the table owner does not skip policies. Superusers
-- bypass RLS regardless; the app must not use a superuser connection.
--
-- Roles are cluster-wide. Passwords are not set here. Jake sets them in the
-- Supabase SQL editor after the migration, and only in the dashboard.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'skyway_owner') THEN
    CREATE ROLE skyway_owner NOLOGIN NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'skyway_app') THEN
    CREATE ROLE skyway_app NOLOGIN NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'skyway_migration') THEN
    CREATE ROLE skyway_migration NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END
$$;

ALTER ROLE skyway_owner NOLOGIN NOINHERIT NOBYPASSRLS;
ALTER ROLE skyway_app NOLOGIN NOINHERIT NOBYPASSRLS;
ALTER ROLE skyway_migration NOLOGIN NOINHERIT BYPASSRLS;

GRANT USAGE ON SCHEMA public TO skyway_app, skyway_migration, skyway_owner;

DO $$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO skyway_app, skyway_migration, skyway_owner',
    current_database()
  );
END
$$;
