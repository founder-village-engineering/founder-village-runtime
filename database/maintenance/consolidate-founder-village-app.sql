-- Run from the verified PostgreSQL server. By default the rehearsal rolls back.
-- See docs/runbooks/CONSOLIDATE_APP.md for the write freeze and recovery boundary.
\set ON_ERROR_STOP on
\set VERBOSITY terse
\if :{?apply}
\else
  \set apply off
\endif

BEGIN;
SET LOCAL search_path = pg_catalog;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(51827009);

DO $$
BEGIN
  IF current_database() <> 'founder-village-app' OR session_user <> 'postgres' THEN
    RAISE EXCEPTION 'Expected the founder-village-app database and its PostgreSQL operator';
  END IF;
END $$;

CREATE SCHEMA fv_consolidation;
CREATE EXTENSION dblink WITH SCHEMA fv_consolidation;
REVOKE USAGE ON SCHEMA fv_consolidation FROM PUBLIC;
SELECT fv_consolidation.dblink_connect('deliveries', 'dbname=founders options=-csearch_path=');
SELECT fv_consolidation.dblink_connect('membership', 'dbname=founder-village-members options=-csearch_path=');
SELECT fv_consolidation.dblink_exec(source, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
FROM unnest(ARRAY['deliveries', 'membership']) AS sources(source);

CREATE FUNCTION pg_temp.source_rows(source text, table_name text) RETURNS SETOF jsonb
LANGUAGE sql AS $$
  SELECT row_data FROM fv_consolidation.dblink(
    source, format('SELECT to_jsonb(t) FROM app.%I AS t', table_name)
  ) AS rows(row_data jsonb)
$$;

-- Keep delivery tenant IDs stable. An ID reused by the old Members database
-- receives a separate stable UUID so the two membership sets are never united.
CREATE TEMP TABLE membership_tenants AS
WITH membership AS (
  SELECT (data->>'id')::uuid AS id FROM pg_temp.source_rows('membership', 'tenants') AS data
), deliveries AS (
  SELECT (data->>'id')::uuid AS id FROM pg_temp.source_rows('deliveries', 'tenants') AS data
), mapped AS (
  SELECT m.id, CASE WHEN d.id IS NOT NULL THEN md5('founder-village-members:' || m.id::text) END AS hash
  FROM membership AS m LEFT JOIN deliveries AS d ON d.id = m.id
)
SELECT id AS old_id,
       CASE WHEN hash IS NULL THEN id
         ELSE (substr(hash, 1, 12) || '5' || substr(hash, 14, 3) || '8' || substr(hash, 18))::uuid
       END AS new_id
FROM mapped;

CREATE TEMP TABLE consolidation_counts (source text, table_name text, rows_copied bigint);

DO $$
DECLARE
  community constant uuid := 'a7c22ce4-dcee-442c-b809-7eb9b14a5d53';
  common_tables constant text[] := ARRAY[
    'tenants', 'memberships', 'records', 'request_keys', 'outbox',
    'job_effects', 'schedules', 'scheduler_runs'
  ];
  delivery_tables constant text[] := ARRAY[
    'members', 'companies', 'expenses', 'food_deliveries', 'food_delivery_request_keys'
  ];
  member_tables constant text[] := ARRAY['member_profiles', 'member_checkouts'];
  source text;
  table_name text;
  source_tables text[];
  nonempty boolean;
  copied bigint;
BEGIN
  IF NOT EXISTS (SELECT FROM pg_temp.membership_tenants WHERE old_id = community AND new_id = community) THEN
    RAISE EXCEPTION 'Members community must keep its original tenant ID';
  END IF;

  FOREACH table_name IN ARRAY common_tables || delivery_tables || member_tables LOOP
    EXECUTE format('LOCK TABLE app.%I IN SHARE ROW EXCLUSIVE MODE', table_name);
    IF table_name <> 'tenants' THEN
      EXECUTE format('SELECT EXISTS (SELECT FROM app.%I)', table_name) INTO nonempty;
      IF nonempty THEN
        RAISE EXCEPTION 'Destination table % is populated. Reconcile before retrying', table_name;
      END IF;
    END IF;
  END LOOP;
  IF EXISTS (SELECT FROM app.tenants WHERE id <> community OR name <> 'Founder Village Members') THEN
    RAISE EXCEPTION 'Destination must have only the migration-created Members community';
  END IF;
  IF (SELECT count(*) FROM app.tenants) <> 1 THEN
    RAISE EXCEPTION 'Destination must have its schema and Members community';
  END IF;

  -- Schedules fan out over all tenants in an application. Published work is
  -- still addressed to an old broker queue. Settle both before cutover.
  FOREACH source IN ARRAY ARRAY['deliveries', 'membership'] LOOP
    source_tables := common_tables || CASE source WHEN 'deliveries' THEN delivery_tables ELSE member_tables END;
    IF ARRAY(SELECT name FROM fv_consolidation.dblink(source,
      $query$SELECT tablename::text FROM pg_tables WHERE schemaname = 'app' ORDER BY tablename::text$query$
    ) AS tables(name text)) <> ARRAY(SELECT name FROM unnest(source_tables) AS tables(name) ORDER BY name) THEN
      RAISE EXCEPTION 'Unexpected app table inventory in %', source;
    END IF;
    IF EXISTS (SELECT FROM pg_temp.source_rows(source,'outbox') AS data WHERE data->>'state' = 'published') OR
       EXISTS (SELECT FROM pg_temp.source_rows(source,'schedules') AS data WHERE (data->>'enabled')::boolean) THEN
      RAISE EXCEPTION 'Reconcile published jobs and enabled schedules in % before cutover', source;
    END IF;
  END LOOP;

  -- Import existing delivery expenses and their original IDs. Keep the other
  -- triggers and all constraints active while the owning table is locked.
  ALTER TABLE app.food_deliveries DISABLE TRIGGER create_food_delivery_expense;
  FOREACH source IN ARRAY ARRAY['deliveries', 'membership'] LOOP
    FOREACH table_name IN ARRAY common_tables || CASE source WHEN 'deliveries' THEN delivery_tables ELSE member_tables END LOOP
      EXECUTE format($copy$
        INSERT INTO app.%1$I
        SELECT (jsonb_populate_record(NULL::app.%1$I, CASE
          WHEN map.new_id IS NOT NULL THEN jsonb_set(data, ARRAY[$3], to_jsonb(map.new_id))
          ELSE data
        END)).*
        FROM pg_temp.source_rows($1, $2) AS data
        LEFT JOIN pg_temp.membership_tenants AS map
          ON $1 = 'membership' AND map.old_id = (data->>$3)::uuid
        WHERE NOT ($2 = 'tenants' AND $1 = 'membership' AND (data->>'id')::uuid = $4)
      $copy$, table_name)
      USING source, table_name, CASE table_name WHEN 'tenants' THEN 'id' ELSE 'tenant_id' END, community;
      GET DIAGNOSTICS copied = ROW_COUNT;
      INSERT INTO pg_temp.consolidation_counts VALUES (source, table_name, copied);
    END LOOP;
  END LOOP;
  ALTER TABLE app.food_deliveries ENABLE TRIGGER create_food_delivery_expense;
END $$;

SELECT source, table_name, rows_copied FROM pg_temp.consolidation_counts ORDER BY source, table_name;
SELECT count(*) AS remapped_membership_tenants FROM pg_temp.membership_tenants WHERE old_id <> new_id;
SELECT fv_consolidation.dblink_disconnect(source) FROM unnest(ARRAY['deliveries', 'membership']) AS sources(source);
DROP EXTENSION dblink;
DROP SCHEMA fv_consolidation;
\if :apply
  COMMIT;
\else
  ROLLBACK;
\endif
