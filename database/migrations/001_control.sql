CREATE SCHEMA IF NOT EXISTS control;
CREATE TABLE control.administrators(actor text PRIMARY KEY, actions text[] NOT NULL, enabled boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE control.sessions(token_hash text PRIMARY KEY, actor text NOT NULL REFERENCES control.administrators(actor), csrf_hash text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE control.login_attempts(id text PRIMARY KEY, verifier text NOT NULL, nonce text NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE control.operations(
 id uuid PRIMARY KEY, actor text NOT NULL, environment text NOT NULL CHECK(environment IN ('local','staging','production')),
 action text NOT NULL, parameters jsonb NOT NULL, idempotency_key text NOT NULL, request_hash text NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','succeeded','failed','cancelled')),
 lease_until timestamptz, attempts integer NOT NULL DEFAULT 0, result jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(actor,idempotency_key)
);
CREATE TABLE control.audit(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor text NOT NULL, event text NOT NULL, resource text NOT NULL, outcome text NOT NULL, operation_id uuid, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), previous_hash text NOT NULL, hash text NOT NULL);
CREATE FUNCTION control.append_audit(a text,e text,r text,o text,j uuid DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control,public AS $$
DECLARE prev text; stamp timestamptz:=clock_timestamp();
BEGIN
 PERFORM pg_advisory_xact_lock(51827001);
 SELECT hash INTO prev FROM control.audit ORDER BY id DESC LIMIT 1;
 prev:=COALESCE(prev,repeat('0',64));
 INSERT INTO control.audit(actor,event,resource,outcome,operation_id,created_at,previous_hash,hash) VALUES(a,e,r,o,j,stamp,prev,encode(digest(concat_ws('|',prev,a,e,r,o,COALESCE(j::text,''),stamp::text),'sha256'),'hex'));
END $$;
REVOKE ALL ON FUNCTION control.append_audit(text,text,text,text,uuid) FROM PUBLIC;
CREATE FUNCTION control.forbid_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable audit ledger'; END $$;
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE OR TRUNCATE ON control.audit FOR EACH STATEMENT EXECUTE FUNCTION control.forbid_audit_mutation();
CREATE TABLE control.deployments(id uuid PRIMARY KEY, revision text NOT NULL, manifest_hash text NOT NULL, color text NOT NULL, state text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE control.backups(id uuid PRIMARY KEY, manifest_hash text NOT NULL, offsite boolean NOT NULL, verified boolean NOT NULL, restored boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE control.dns_plans(id uuid PRIMARY KEY, actor text NOT NULL, zone_id text NOT NULL, record_name text NOT NULL, before_state jsonb, desired jsonb, fingerprint text NOT NULL, expires_at timestamptz NOT NULL, applied_at timestamptz);
CREATE TABLE control.wireguard_peers(name text PRIMARY KEY, public_key text UNIQUE NOT NULL, address inet UNIQUE NOT NULL, enabled boolean NOT NULL DEFAULT true, expires_at timestamptz NOT NULL);
GRANT USAGE ON SCHEMA control TO fv_admin,fv_runner;
GRANT SELECT,INSERT,UPDATE,DELETE ON control.sessions,control.login_attempts TO fv_admin;
GRANT SELECT,INSERT,UPDATE ON control.administrators,control.operations,control.dns_plans TO fv_admin;
GRANT SELECT ON control.audit,control.deployments,control.backups,control.wireguard_peers TO fv_admin;
GRANT EXECUTE ON FUNCTION control.append_audit(text,text,text,text,uuid) TO fv_admin,fv_runner;
GRANT SELECT,UPDATE ON control.operations TO fv_runner;
GRANT SELECT ON control.administrators,control.dns_plans TO fv_runner;
GRANT INSERT,SELECT,UPDATE ON control.deployments,control.backups,control.wireguard_peers TO fv_runner;

GRANT UPDATE ON control.dns_plans TO fv_runner;
GRANT SELECT ON control.audit TO fv_runner;
