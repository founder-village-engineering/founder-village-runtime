-- Keep the original user in owner_actor and attribute imports to the database operator.
CREATE OR REPLACE FUNCTION app.capture_bot_version() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app AS $$
DECLARE
  performer text;
BEGIN
  IF TG_OP='INSERT' AND NEW.source_id IS NOT NULL THEN
    performer := session_user;
  ELSE
    performer := coalesce(nullif(current_setting('fv.actor',true),''),session_user);
  END IF;
  INSERT INTO app.team_bot_history(tenant_id,bot_id,actor,payload)
  VALUES(NEW.tenant_id,NEW.id,performer,NEW.payload);
  RETURN NEW;
END
$$;
