-- Only the local operator issues one-use codes. The API can exchange a known
-- code and resolve a known session hash, but cannot list or issue credentials.
CREATE TABLE app.team_local_signins (
  code_hash text PRIMARY KEY,
  actor text NOT NULL,
  code_expires_at timestamptz NOT NULL,
  session_hash text UNIQUE,
  session_expires_at timestamptz
);
REVOKE ALL ON app.team_local_signins FROM PUBLIC, fv_api, fv_hasura, fv_worker;
CREATE FUNCTION app.exchange_team_code(code_digest text, session_digest text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  WITH redeemed AS (
    UPDATE app.team_local_signins SET session_hash = session_digest, session_expires_at = now() + interval '15 minutes'
    WHERE code_hash = code_digest AND session_hash IS NULL AND code_expires_at > now()
      AND EXISTS (SELECT 1 FROM app.memberships m WHERE m.actor = team_local_signins.actor AND m.enabled)
    RETURNING 1
  ) SELECT EXISTS(SELECT FROM redeemed)
$$;
CREATE FUNCTION app.team_session_actor(session_digest text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT actor FROM app.team_local_signins WHERE session_hash = session_digest AND session_expires_at > now()
$$;
REVOKE ALL ON FUNCTION app.exchange_team_code(text,text), app.team_session_actor(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.exchange_team_code(text,text), app.team_session_actor(text) TO fv_founder_village_team_api;
