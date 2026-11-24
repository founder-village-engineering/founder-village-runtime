CREATE TABLE app.team_engineering_items (
  tenant_id uuid NOT NULL REFERENCES app.tenants(id),
  id uuid NOT NULL,
  payload bytea NOT NULL,
  status text NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog','in_progress','done')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id)
);
CREATE INDEX team_engineering_by_time ON app.team_engineering_items(tenant_id,created_at DESC,id DESC);

ALTER TABLE app.team_engineering_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.team_engineering_items FORCE ROW LEVEL SECURITY;
CREATE POLICY team_engineering_scope ON app.team_engineering_items TO fv_api USING (
  tenant_id::text=current_setting('fv.tenant',true) AND app.is_member(tenant_id)
);
CREATE POLICY team_engineering_migrator ON app.team_engineering_items TO fv_founder_village_team_migrator USING (true);
GRANT SELECT, INSERT ON app.team_engineering_items TO fv_api;
GRANT UPDATE (status,revision,updated_at) ON app.team_engineering_items TO fv_api;

CREATE TABLE app.team_engineering_history (
  tenant_id uuid NOT NULL,
  item_id uuid NOT NULL,
  revision integer NOT NULL,
  status text NOT NULL,
  payload bytea NOT NULL,
  actor text NOT NULL,
  request_id text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,item_id,revision),
  FOREIGN KEY (tenant_id,item_id) REFERENCES app.team_engineering_items(tenant_id,id)
);
CREATE FUNCTION app.capture_engineering_version() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app AS $$
BEGIN
  INSERT INTO app.team_engineering_history(tenant_id,item_id,revision,status,payload,actor,request_id)
  VALUES(NEW.tenant_id,NEW.id,NEW.revision,NEW.status,NEW.payload,
    coalesce(nullif(current_setting('fv.actor',true),''),session_user),
    nullif(current_setting('fv.engineering_request',true),''));
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.capture_engineering_version() FROM PUBLIC;
CREATE TRIGGER record_engineering_version AFTER INSERT OR UPDATE ON app.team_engineering_items
FOR EACH ROW EXECUTE FUNCTION app.capture_engineering_version();
