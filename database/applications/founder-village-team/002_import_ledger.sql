-- Operator-only source reconciliation. Application and Hasura roles receive no grants.
CREATE TABLE app.team_import_members (
  tenant_id uuid NOT NULL REFERENCES app.team_import_origins(tenant_id),
  source_member_key text NOT NULL,
  actor text NOT NULL,
  PRIMARY KEY (tenant_id,source_member_key),
  UNIQUE (tenant_id,actor),
  FOREIGN KEY (tenant_id,actor) REFERENCES app.memberships(tenant_id,actor)
);

CREATE TABLE app.team_import_batches (
  tenant_id uuid NOT NULL REFERENCES app.team_import_origins(tenant_id),
  archive_digest text NOT NULL CHECK (archive_digest ~ '^[a-f0-9]{64}$'),
  imported_at timestamptz NOT NULL DEFAULT now(),
  imported_by name NOT NULL DEFAULT session_user,
  bot_count bigint NOT NULL CHECK (bot_count >= 0),
  conversation_count bigint NOT NULL CHECK (conversation_count >= 0),
  message_count bigint NOT NULL CHECK (message_count >= 0),
  PRIMARY KEY (tenant_id,archive_digest)
);
