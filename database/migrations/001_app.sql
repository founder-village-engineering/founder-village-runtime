CREATE SCHEMA IF NOT EXISTS app;
CREATE TABLE app.tenants (id uuid PRIMARY KEY, name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120));
CREATE TABLE app.memberships (tenant_id uuid NOT NULL REFERENCES app.tenants(id), actor text NOT NULL, enabled boolean NOT NULL DEFAULT true, PRIMARY KEY(tenant_id,actor));
CREATE FUNCTION app.is_member(t uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$ SELECT EXISTS(SELECT 1 FROM app.memberships WHERE tenant_id=t AND actor=current_setting('fv.actor',true) AND enabled) $$;
REVOKE ALL ON FUNCTION app.is_member(uuid) FROM PUBLIC;
CREATE TABLE app.records (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES app.tenants(id), created_by text NOT NULL,
 content text NOT NULL CHECK(length(content) BETWEEN 1 AND 4000), result text,
 embedding vector(3) NOT NULL, embedding_model text NOT NULL DEFAULT 'synthetic-v1',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON app.records(tenant_id,created_at);
CREATE INDEX ON app.records USING hnsw(embedding vector_cosine_ops);
ALTER TABLE app.records ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_records ON app.records USING (tenant_id::text=current_setting('fv.tenant',true) AND (app.is_member(tenant_id) OR pg_has_role(current_user,'fv_worker','member'))) WITH CHECK (tenant_id::text=current_setting('fv.tenant',true) AND (app.is_member(tenant_id) OR pg_has_role(current_user,'fv_worker','member')));
CREATE TABLE app.outbox (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES app.tenants(id), record_id uuid NOT NULL,
 actor text NOT NULL, correlation_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('record.process','maintenance.sweep')),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','published','completed','dead')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), available_at timestamptz NOT NULL DEFAULT now(),
 published_at timestamptz, completed_at timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON app.outbox(available_at) WHERE state='pending';
ALTER TABLE app.outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_outbox ON app.outbox TO fv_api USING (tenant_id::text=current_setting('fv.tenant',true) AND app.is_member(tenant_id)) WITH CHECK (tenant_id::text=current_setting('fv.tenant',true) AND app.is_member(tenant_id));
CREATE POLICY worker_outbox ON app.outbox TO fv_worker USING(true) WITH CHECK(true);
CREATE TABLE app.job_effects(job_id uuid PRIMARY KEY REFERENCES app.outbox(id), completed_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE app.schedules(id uuid PRIMARY KEY, name text UNIQUE NOT NULL, interval_seconds integer NOT NULL CHECK(interval_seconds BETWEEN 60 AND 2592000), next_run timestamptz NOT NULL, actor text NOT NULL, enabled boolean NOT NULL DEFAULT true);
CREATE TABLE app.scheduler_runs(schedule_id uuid REFERENCES app.schedules(id), due_at timestamptz, PRIMARY KEY(schedule_id,due_at));
CREATE TABLE app.request_keys(tenant_id uuid NOT NULL, actor text NOT NULL, key text NOT NULL, request_hash text NOT NULL, record_id uuid NOT NULL, PRIMARY KEY(tenant_id,actor,key));
ALTER TABLE app.request_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_keys ON app.request_keys USING(tenant_id::text=current_setting('fv.tenant',true) AND actor=current_setting('fv.actor',true)) WITH CHECK(tenant_id::text=current_setting('fv.tenant',true) AND actor=current_setting('fv.actor',true));
GRANT USAGE ON SCHEMA app TO fv_api,fv_worker,fv_hasura;
GRANT EXECUTE ON FUNCTION app.is_member(uuid) TO fv_api,fv_worker;
GRANT SELECT,INSERT ON app.records TO fv_api;
GRANT SELECT,INSERT ON app.outbox,app.request_keys TO fv_api;
GRANT SELECT,UPDATE ON app.records TO fv_worker;
GRANT SELECT,INSERT,UPDATE ON app.outbox,app.job_effects,app.schedules,app.scheduler_runs TO fv_worker;
GRANT SELECT ON app.records TO fv_hasura;
CREATE POLICY hasura_records ON app.records TO fv_hasura USING (true);
CREATE FUNCTION app.metrics() RETURNS json LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ SELECT json_build_object('pending',count(*) FILTER(WHERE state='pending'),'published',count(*) FILTER(WHERE state='published'),'dead',count(*) FILTER(WHERE state='dead'),'completed',count(*) FILTER(WHERE state='completed')) FROM app.outbox $$;
REVOKE ALL ON FUNCTION app.metrics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.metrics() TO fv_api,fv_worker;

GRANT SELECT ON app.tenants TO fv_worker;
