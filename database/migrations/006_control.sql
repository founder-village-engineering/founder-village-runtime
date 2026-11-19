-- Code issuance belongs to the existing session issuer, not background workers.
-- fv_admin already owns session creation; fv_runner must not mint root logins.
REVOKE INSERT ON control.local_admin_codes FROM fv_runner;
GRANT INSERT ON control.local_admin_codes TO fv_admin;
