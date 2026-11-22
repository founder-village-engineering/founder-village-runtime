INSERT INTO app.tenants (id, name) VALUES ('a7c22ce4-dcee-442c-b809-7eb9b14a5d53', 'Founder Village Members');

CREATE TABLE app.member_profiles (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants(id),
  actor text NOT NULL,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 2 AND 60),
  headline text CHECK (length(btrim(headline)) BETWEEN 1 AND 100),
  location text CHECK (length(btrim(location)) BETWEEN 1 AND 60),
  listed boolean NOT NULL,
  whatsapp_number text CHECK (whatsapp_number ~ '^\+[1-9][0-9]{7,14}$'),
  UNIQUE (tenant_id, actor)
);
CREATE INDEX member_profiles_directory ON app.member_profiles (tenant_id, lower(display_name), id) WHERE listed;
ALTER TABLE app.member_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.member_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY member_owns_profile ON app.member_profiles TO fv_api
  USING (tenant_id::text = current_setting('fv.tenant', true) AND actor = current_setting('fv.actor', true));
CREATE POLICY member_profile_functions ON app.member_profiles TO fv_founder_village_members_migrator USING (true);
GRANT SELECT, INSERT, DELETE ON app.member_profiles TO fv_api;
GRANT UPDATE (display_name, headline, location, listed, whatsapp_number) ON app.member_profiles TO fv_api;

-- Only the authenticated directory functions can read any other profile.
CREATE FUNCTION app.directory_members(search text, after_id uuid)
RETURNS TABLE (id uuid, display_name text, headline text, location text, whatsapp_available boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT p.id, p.display_name, p.headline, p.location, p.whatsapp_number IS NOT NULL
  FROM app.member_profiles p
  WHERE p.tenant_id::text = current_setting('fv.tenant', true)
    AND p.actor <> current_setting('fv.actor', true)
    AND p.listed
    AND EXISTS (SELECT 1 FROM app.member_profiles m
      WHERE m.tenant_id = p.tenant_id AND m.actor = current_setting('fv.actor', true))
    AND strpos(lower(concat_ws(' ', p.display_name, p.headline, p.location)), lower(search)) > 0
    AND (after_id IS NULL OR (lower(p.display_name), p.id) > (
      SELECT lower(cursor.display_name), cursor.id FROM app.member_profiles cursor
      WHERE cursor.id = after_id AND cursor.tenant_id = p.tenant_id AND cursor.listed
    ))
  ORDER BY lower(p.display_name), p.id
  LIMIT 25
$$;
CREATE FUNCTION app.directory_whatsapp(member_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT p.whatsapp_number FROM app.member_profiles p
  WHERE p.id = member_id AND p.listed
    AND p.tenant_id::text = current_setting('fv.tenant', true)
    AND p.actor <> current_setting('fv.actor', true)
    AND EXISTS (SELECT 1 FROM app.member_profiles m
      WHERE m.tenant_id = p.tenant_id AND m.actor = current_setting('fv.actor', true))
$$;
REVOKE ALL ON FUNCTION app.directory_members(text, uuid), app.directory_whatsapp(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.directory_members(text, uuid), app.directory_whatsapp(uuid) TO fv_api;

CREATE TABLE app.member_checkouts (
  id uuid PRIMARY KEY,
  member_id uuid REFERENCES app.member_profiles(id) ON DELETE SET NULL,
  request_key uuid NOT NULL,
  method text NOT NULL CHECK (method IN ('card', 'sol', 'usdc')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'expired', 'reversed')),
  amount_units bigint NOT NULL CHECK (amount_units > 0),
  test boolean NOT NULL,
  recipient text,
  reference text UNIQUE,
  stripe_session text UNIQUE,
  payment_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  next_check_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, request_key),
  CHECK ((method = 'card' AND recipient IS NULL AND reference IS NULL)
      OR (method IN ('sol', 'usdc') AND recipient IS NOT NULL AND reference IS NOT NULL AND stripe_session IS NULL)),
  CHECK (status NOT IN ('paid', 'reversed') OR payment_id IS NOT NULL)
);
CREATE UNIQUE INDEX member_only_one_pending ON app.member_checkouts (member_id) WHERE status = 'pending';
CREATE INDEX member_checkouts_history ON app.member_checkouts (member_id, created_at DESC);
CREATE INDEX member_checkouts_reconcile ON app.member_checkouts (next_check_at) WHERE status = 'pending' AND method <> 'card';
ALTER TABLE app.member_checkouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.member_checkouts FORCE ROW LEVEL SECURITY;
CREATE POLICY member_reads_checkout ON app.member_checkouts TO fv_api
  USING (EXISTS (SELECT 1 FROM app.member_profiles p WHERE p.id = member_id));
CREATE POLICY member_stripe_settlement ON app.member_checkouts TO fv_api
  USING (method = 'card' AND current_setting('fv.members_settlement', true) = 'stripe');
CREATE POLICY member_solana_settlement ON app.member_checkouts TO fv_api
  USING (method <> 'card' AND current_setting('fv.members_settlement', true) = 'solana');
CREATE POLICY member_checkout_migrator ON app.member_checkouts TO fv_founder_village_members_migrator USING (true);
GRANT SELECT, INSERT ON app.member_checkouts TO fv_api;
GRANT UPDATE (status, stripe_session, payment_id, next_check_at) ON app.member_checkouts TO fv_api;
