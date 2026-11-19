CREATE TABLE control.local_admin_codes (
 token_hash text PRIMARY KEY CHECK (length(token_hash)=64),
 actor text NOT NULL REFERENCES control.administrators(actor),
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT,DELETE ON control.local_admin_codes TO fv_admin;
GRANT SELECT,INSERT,DELETE ON control.local_admin_codes TO fv_runner;
CREATE INDEX local_admin_codes_expiry ON control.local_admin_codes(expires_at);

-- Invalidate sessions issued before credential-based local sign-in. This is a
-- one-time authentication cutover; later migration runs are checksummed no-ops.
DELETE FROM control.sessions WHERE actor LIKE 'https://local.fv|%' OR actor LIKE 'https://local.fv.test|%';
