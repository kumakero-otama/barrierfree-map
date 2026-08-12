\set ON_ERROR_STOP on

ALTER DATABASE stepby_app_dev OWNER TO stepby_dev;

SELECT format('ALTER SCHEMA %I OWNER TO stepby_dev', nspname)
FROM pg_namespace
WHERE nspname IN ('experiment', 'login', 'osmchange', 'roadinfo', 'tactile')
\gexec

SELECT format('ALTER TABLE %I.%I OWNER TO stepby_dev', schemaname, tablename)
FROM pg_tables
WHERE schemaname IN ('experiment', 'login', 'osmchange', 'roadinfo', 'tactile')
\gexec

SELECT format('ALTER SEQUENCE %I.%I OWNER TO stepby_dev', sequence_schema, sequence_name)
FROM information_schema.sequences
WHERE sequence_schema IN ('experiment', 'login', 'osmchange', 'roadinfo', 'tactile')
\gexec

SELECT format('ALTER FUNCTION %I.%I(%s) OWNER TO stepby_dev', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname IN ('experiment', 'login', 'osmchange', 'roadinfo', 'tactile')
\gexec
