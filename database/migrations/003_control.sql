CREATE TABLE control.audit_checkpoints(last_id bigint PRIMARY KEY, object_key text UNIQUE NOT NULL, signature text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT,INSERT ON control.audit_checkpoints TO fv_runner;
