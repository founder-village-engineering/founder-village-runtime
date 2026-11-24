-- Reserve a message before contacting the provider. A lost response or process
-- crash leaves the reservation intact, including across API restarts.
CREATE TABLE app.team_reply_attempts (
  tenant_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  message_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','rejected','uncertain','completed')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,conversation_id,message_id),
  FOREIGN KEY (tenant_id,conversation_id,message_id) REFERENCES app.team_messages(tenant_id,conversation_id,id)
);
ALTER TABLE app.team_reply_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.team_reply_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY own_team_reply_attempt ON app.team_reply_attempts TO fv_api USING (
  EXISTS (SELECT FROM app.team_conversations c WHERE c.tenant_id=team_reply_attempts.tenant_id AND c.id=team_reply_attempts.conversation_id)
);
GRANT SELECT, INSERT ON app.team_reply_attempts TO fv_api;
GRANT UPDATE(state,updated_at) ON app.team_reply_attempts TO fv_api;
