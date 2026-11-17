GRANT USAGE ON SCHEMA app TO fv_monitor;
GRANT EXECUTE ON FUNCTION app.metrics() TO fv_monitor;
GRANT SELECT ON public.fv_migrations TO fv_monitor;
CREATE FUNCTION app.my_tenants() RETURNS TABLE(id uuid,name text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$ SELECT t.id,t.name FROM app.tenants t JOIN app.memberships m ON m.tenant_id=t.id WHERE m.actor=current_setting('fv.actor',true) AND m.enabled $$;
REVOKE ALL ON FUNCTION app.my_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_tenants() TO fv_api;
