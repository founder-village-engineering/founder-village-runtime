CREATE TABLE app.team_bots (
  tenant_id uuid NOT NULL REFERENCES app.tenants(id),
  id uuid NOT NULL,
  owner_actor text NOT NULL,
  reader_actors text[] NOT NULL DEFAULT '{}',
  manager_actors text[] NOT NULL DEFAULT '{}',
  visibility text NOT NULL CHECK (visibility IN ('private','selected','team')),
  payload bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  source_id text,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,source_id),
  CHECK (visibility <> 'private' OR (cardinality(reader_actors)=0 AND cardinality(manager_actors)=0))
);
CREATE TABLE app.team_conversations (
  tenant_id uuid NOT NULL REFERENCES app.tenants(id),
  id uuid NOT NULL,
  owner_actor text NOT NULL,
  bot_id uuid,
  payload bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  source_id text,
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,bot_id) REFERENCES app.team_bots(tenant_id,id),
  UNIQUE (tenant_id,owner_actor,source_id)
);
CREATE TABLE app.team_messages (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('user','assistant','system','tool')),
  position bigint NOT NULL CHECK (position BETWEEN 1 AND 9007199254740991),
  payload bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  source_id text,
  in_reply_to uuid,
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,conversation_id) REFERENCES app.team_conversations(tenant_id,id),
  UNIQUE (tenant_id,conversation_id,source_id),
  UNIQUE (tenant_id,conversation_id,position),
  UNIQUE (tenant_id,conversation_id,id),
  FOREIGN KEY (tenant_id,conversation_id,in_reply_to) REFERENCES app.team_messages(tenant_id,conversation_id,id),
  UNIQUE (tenant_id,conversation_id,in_reply_to)
);
CREATE TABLE app.team_receipts (
  tenant_id uuid NOT NULL REFERENCES app.tenants(id),
  actor text NOT NULL,
  key uuid NOT NULL,
  request_hash text NOT NULL,
  payload bytea NOT NULL,
  PRIMARY KEY (tenant_id,actor,key)
);
CREATE INDEX team_chats_by_owner ON app.team_conversations(tenant_id,owner_actor,created_at,id);
CREATE INDEX team_bots_by_time ON app.team_bots(tenant_id,created_at,id);

ALTER TABLE app.team_bots ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.team_bots FORCE ROW LEVEL SECURITY;
ALTER TABLE app.team_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.team_conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE app.team_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.team_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE app.team_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.team_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY team_bot_read ON app.team_bots FOR SELECT TO fv_api USING (
  tenant_id::text=current_setting('fv.tenant',true) AND app.is_member(tenant_id)
  AND (visibility='team' OR owner_actor=current_setting('fv.actor',true)
    OR current_setting('fv.actor',true)=ANY(manager_actors) OR current_setting('fv.actor',true)=ANY(reader_actors))
);
CREATE POLICY team_bot_create ON app.team_bots FOR INSERT TO fv_api WITH CHECK (
  tenant_id::text=current_setting('fv.tenant',true) AND app.is_member(tenant_id)
  AND owner_actor=current_setting('fv.actor',true)
);
CREATE POLICY team_chat_owner ON app.team_conversations TO fv_api USING (
  tenant_id::text=current_setting('fv.tenant',true) AND app.is_member(tenant_id) AND owner_actor=current_setting('fv.actor',true)
) WITH CHECK (
  tenant_id::text=current_setting('fv.tenant',true) AND app.is_member(tenant_id) AND owner_actor=current_setting('fv.actor',true)
  AND (bot_id IS NULL OR EXISTS (SELECT FROM app.team_bots b WHERE b.tenant_id=team_conversations.tenant_id AND b.id=team_conversations.bot_id))
);
CREATE POLICY team_chat_messages ON app.team_messages TO fv_api USING (
  EXISTS (SELECT FROM app.team_conversations c WHERE c.tenant_id=team_messages.tenant_id AND c.id=team_messages.conversation_id)
);
CREATE POLICY team_own_receipt ON app.team_receipts TO fv_api USING (
  tenant_id::text=current_setting('fv.tenant',true) AND app.is_member(tenant_id) AND actor=current_setting('fv.actor',true)
);
GRANT SELECT, INSERT ON app.team_bots, app.team_conversations, app.team_messages, app.team_receipts TO fv_api;

-- No application-role grants. Only the operator's verified import can bind a source team.
CREATE TABLE app.team_import_origins (
  tenant_id uuid PRIMARY KEY REFERENCES app.tenants(id),
  source_team_key text UNIQUE NOT NULL
);
CREATE POLICY team_bot_migrator ON app.team_bots TO fv_founder_village_team_migrator USING (true);
CREATE POLICY team_conversation_migrator ON app.team_conversations TO fv_founder_village_team_migrator USING (true);
CREATE POLICY team_message_migrator ON app.team_messages TO fv_founder_village_team_migrator USING (true);

CREATE POLICY team_bot_edit ON app.team_bots FOR UPDATE TO fv_api USING (
  tenant_id::text=current_setting('fv.tenant',true) AND app.is_member(tenant_id)
  AND (owner_actor=current_setting('fv.actor',true) OR current_setting('fv.actor',true)=ANY(manager_actors))
);
GRANT UPDATE (payload) ON app.team_bots TO fv_api;
CREATE TABLE app.team_bot_history (
  version bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  bot_id uuid NOT NULL,
  actor text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  payload bytea NOT NULL,
  FOREIGN KEY (tenant_id,bot_id) REFERENCES app.team_bots(tenant_id,id)
);
CREATE FUNCTION app.capture_bot_version() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app AS $$
BEGIN
  INSERT INTO app.team_bot_history(tenant_id,bot_id,actor,payload)
  VALUES(NEW.tenant_id,NEW.id,coalesce(nullif(current_setting('fv.actor',true),''),session_user),NEW.payload);
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.capture_bot_version() FROM PUBLIC;
CREATE TRIGGER record_bot_version AFTER INSERT OR UPDATE ON app.team_bots FOR EACH ROW EXECUTE FUNCTION app.capture_bot_version();
