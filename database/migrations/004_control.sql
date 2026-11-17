ALTER TABLE control.operations ADD COLUMN auth_proof text;
ALTER TABLE control.operations DROP CONSTRAINT operations_state_check;
ALTER TABLE control.operations ADD CONSTRAINT operations_state_check CHECK(state IN ('awaiting_authorization','queued','running','succeeded','failed','cancelled'));
ALTER TABLE control.login_attempts ADD COLUMN operation_id uuid;
CREATE TABLE control.operation_authorizations(operation_id uuid PRIMARY KEY REFERENCES control.operations(id),nonce text UNIQUE NOT NULL,authorized_at timestamptz NOT NULL DEFAULT now());
GRANT INSERT,SELECT ON control.operation_authorizations TO fv_runner;
