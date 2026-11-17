ALTER TABLE control.administrators ADD COLUMN applications text[] NOT NULL DEFAULT '{}';
CREATE TABLE control.namespace_status(application text PRIMARY KEY, healthy boolean NOT NULL, pending bigint NOT NULL, dead bigint NOT NULL, database_bytes bigint NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now());
GRANT USAGE ON SCHEMA control TO fv_control_monitor;
GRANT SELECT ON control.backups TO fv_control_monitor;
GRANT INSERT,UPDATE,SELECT ON control.namespace_status TO fv_control_monitor;
GRANT SELECT ON control.namespace_status TO fv_admin;
