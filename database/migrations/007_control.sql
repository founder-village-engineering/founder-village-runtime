CREATE TABLE control.audit_anchors (
  last_id bigint PRIMARY KEY REFERENCES control.audit(id),
  signature text NOT NULL CHECK (signature ~ '^[0-9a-f]{64}$')
);

CREATE TRIGGER immutable_audit_anchors BEFORE UPDATE OR DELETE OR TRUNCATE
  ON control.audit_anchors FOR EACH STATEMENT
  EXECUTE FUNCTION control.forbid_audit_mutation();
GRANT SELECT, INSERT ON control.audit_anchors TO fv_runner;
