CREATE FUNCTION app.my_delivery_tenants() RETURNS TABLE(id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT t.id, t.name
  FROM app.my_tenants() AS t
  JOIN app.members AS m ON m.tenant_id = t.id
  WHERE m.actor = current_setting('fv.actor', true) AND m.status = 'active'
$$;
REVOKE ALL ON FUNCTION app.my_delivery_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_delivery_tenants() TO fv_api;
