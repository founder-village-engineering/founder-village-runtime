CREATE TYPE app.member_status AS ENUM ('active', 'inactive');
CREATE TYPE app.expense_direction AS ENUM ('charge', 'credit');
CREATE TYPE app.expense_status AS ENUM ('pending', 'posted', 'void');
CREATE TYPE app.expense_category AS ENUM (
  'food_delivery',
  'membership',
  'workspace',
  'other'
);
CREATE TYPE app.expense_source AS ENUM ('manual', 'food_delivery');
CREATE TYPE app.food_delivery_provider AS ENUM ('ifood', '99food');
CREATE TYPE app.food_delivery_status AS ENUM (
  'placed',
  'accepted',
  'preparing',
  'out_for_delivery',
  'delivered',
  'cancelled'
);

CREATE TABLE app.members (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants(id),
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 512),
  full_name text NOT NULL CHECK (length(full_name) BETWEEN 1 AND 160),
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  phone text CHECK (phone IS NULL OR length(phone) BETWEEN 7 AND 40),
  room text CHECK (room IS NULL OR length(room) BETWEEN 1 AND 80),
  status app.member_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, actor),
  UNIQUE (tenant_id, id)
);

CREATE INDEX members_tenant_status_idx ON app.members(tenant_id, status);

ALTER TABLE app.members ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.members FORCE ROW LEVEL SECURITY;

CREATE POLICY member_self ON app.members
  TO fv_api
  USING (
    tenant_id::text = current_setting('fv.tenant', true)
    AND actor = current_setting('fv.actor', true)
    AND app.is_member(tenant_id)
  );

CREATE POLICY worker_members ON app.members TO fv_worker USING (true);
CREATE POLICY hasura_members ON app.members TO fv_hasura USING (true);

CREATE FUNCTION app.current_member_id(t uuid) RETURNS uuid
LANGUAGE sql STABLE SET search_path=pg_catalog,app AS $$
  SELECT id
  FROM app.members
  WHERE tenant_id=t
    AND actor=current_setting('fv.actor',true)
    AND status='active'
    AND app.is_member(t)
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION app.current_member_id(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_member_id(uuid) TO fv_api;

CREATE TABLE app.companies (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  founder_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  legal_name text CHECK (legal_name IS NULL OR length(legal_name) BETWEEN 1 AND 200),
  website text CHECK (website IS NULL OR length(website) BETWEEN 8 AND 500),
  tax_identifier text CHECK (tax_identifier IS NULL OR length(tax_identifier) BETWEEN 3 AND 80),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, founder_id) REFERENCES app.members(tenant_id, id)
);

CREATE INDEX companies_founder_idx ON app.companies(tenant_id, founder_id);

ALTER TABLE app.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.companies FORCE ROW LEVEL SECURITY;

CREATE POLICY founder_companies ON app.companies
  TO fv_api
  USING (
    tenant_id::text = current_setting('fv.tenant', true)
    AND founder_id = app.current_member_id(tenant_id)
  );

CREATE POLICY worker_companies ON app.companies TO fv_worker USING (true);
CREATE POLICY hasura_companies ON app.companies TO fv_hasura USING (true);

CREATE TABLE app.expenses (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  founder_id uuid NOT NULL,
  company_id uuid,
  direction app.expense_direction NOT NULL,
  status app.expense_status NOT NULL DEFAULT 'posted',
  category app.expense_category NOT NULL,
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 240),
  amount_cents integer NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 10000000),
  currency text NOT NULL DEFAULT 'BRL' CHECK (currency = 'BRL'),
  incurred_at timestamptz NOT NULL,
  source_type app.expense_source NOT NULL DEFAULT 'manual',
  source_id uuid,
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, founder_id) REFERENCES app.members(tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.companies(tenant_id, id),
  CHECK (
    (source_type = 'manual' AND source_id IS NULL)
    OR (source_type = 'food_delivery' AND source_id IS NOT NULL)
  ),
  UNIQUE (tenant_id, source_type, source_id),
  UNIQUE (tenant_id, founder_id, id, source_id)
);

CREATE INDEX expenses_founder_incurred_idx
  ON app.expenses(tenant_id, founder_id, incurred_at DESC);

ALTER TABLE app.expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.expenses FORCE ROW LEVEL SECURITY;

CREATE POLICY founder_expenses ON app.expenses
  TO fv_api
  USING (
    tenant_id::text = current_setting('fv.tenant', true)
    AND founder_id = app.current_member_id(tenant_id)
  )
  WITH CHECK (
    tenant_id::text = current_setting('fv.tenant', true)
    AND founder_id = app.current_member_id(tenant_id)
    AND created_by = current_setting('fv.actor', true)
  );

CREATE POLICY worker_expenses ON app.expenses
  TO fv_worker USING (true) WITH CHECK (true);
CREATE POLICY hasura_expenses ON app.expenses TO fv_hasura USING (true);

CREATE TABLE app.food_deliveries (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  founder_id uuid NOT NULL,
  expense_id uuid NOT NULL UNIQUE,
  provider app.food_delivery_provider NOT NULL,
  provider_order_id text NOT NULL CHECK (length(provider_order_id) BETWEEN 2 AND 80),
  restaurant_name text NOT NULL CHECK (length(restaurant_name) BETWEEN 2 AND 160),
  delivery_address text NOT NULL CHECK (length(delivery_address) BETWEEN 3 AND 240),
  subtotal_cents integer NOT NULL CHECK (subtotal_cents >= 0 AND subtotal_cents <= 10000000),
  delivery_fee_cents integer NOT NULL CHECK (delivery_fee_cents >= 0 AND delivery_fee_cents <= 10000000),
  service_fee_cents integer NOT NULL CHECK (service_fee_cents >= 0 AND service_fee_cents <= 10000000),
  total_cents integer NOT NULL CHECK (
    total_cents > 0
    AND total_cents = subtotal_cents + delivery_fee_cents + service_fee_cents
    AND total_cents <= 10000000
  ),
  currency text NOT NULL DEFAULT 'BRL' CHECK (currency = 'BRL'),
  status app.food_delivery_status NOT NULL DEFAULT 'placed',
  placed_at timestamptz NOT NULL DEFAULT now(),
  expected_at timestamptz,
  notes text CHECK (notes IS NULL OR length(notes) <= 500),
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, founder_id) REFERENCES app.members(tenant_id, id),
  FOREIGN KEY (tenant_id, founder_id, expense_id, id)
    REFERENCES app.expenses(tenant_id, founder_id, id, source_id),
  UNIQUE (tenant_id, provider, provider_order_id)
);

CREATE INDEX food_deliveries_founder_placed_idx
  ON app.food_deliveries(tenant_id, founder_id, placed_at DESC);

ALTER TABLE app.food_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.food_deliveries FORCE ROW LEVEL SECURITY;

CREATE POLICY founder_food_deliveries ON app.food_deliveries
  TO fv_api
  USING (
    tenant_id::text = current_setting('fv.tenant', true)
    AND founder_id = app.current_member_id(tenant_id)
  )
  WITH CHECK (
    tenant_id::text = current_setting('fv.tenant', true)
    AND founder_id = app.current_member_id(tenant_id)
    AND created_by = current_setting('fv.actor', true)
  );

CREATE POLICY worker_food_deliveries ON app.food_deliveries
  TO fv_worker USING (true) WITH CHECK (true);
CREATE POLICY hasura_food_deliveries ON app.food_deliveries
  TO fv_hasura USING (true);

CREATE FUNCTION app.create_food_delivery_expense() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$
BEGIN
  NEW.expense_id = gen_random_uuid();
  INSERT INTO app.expenses(
    id, tenant_id, founder_id, direction, status, category, description,
    amount_cents, currency, incurred_at, source_type, source_id, created_by
  ) VALUES (
    NEW.expense_id, NEW.tenant_id, NEW.founder_id, 'charge', 'posted',
    'food_delivery',
    CASE NEW.provider
      WHEN 'ifood' THEN 'iFood delivery - ' || NEW.restaurant_name
      ELSE '99Food delivery - ' || NEW.restaurant_name
    END,
    NEW.total_cents, NEW.currency, NEW.placed_at, 'food_delivery', NEW.id,
    NEW.created_by
  );
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.create_food_delivery_expense() FROM PUBLIC;

CREATE TRIGGER create_food_delivery_expense
BEFORE INSERT ON app.food_deliveries
FOR EACH ROW EXECUTE FUNCTION app.create_food_delivery_expense();

CREATE FUNCTION app.sync_cancelled_food_delivery_expense() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status <> 'cancelled' THEN
    UPDATE app.expenses
    SET status='void', updated_at=now()
    WHERE id=NEW.expense_id AND tenant_id=NEW.tenant_id;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.sync_cancelled_food_delivery_expense() FROM PUBLIC;

CREATE TRIGGER sync_cancelled_food_delivery_expense
AFTER UPDATE OF status ON app.food_deliveries
FOR EACH ROW EXECUTE FUNCTION app.sync_cancelled_food_delivery_expense();

CREATE TABLE app.food_delivery_request_keys (
  tenant_id uuid NOT NULL,
  actor text NOT NULL,
  key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  delivery_id uuid NOT NULL REFERENCES app.food_deliveries(id),
  PRIMARY KEY (tenant_id, actor, key)
);

ALTER TABLE app.food_delivery_request_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.food_delivery_request_keys FORCE ROW LEVEL SECURITY;

CREATE POLICY founder_food_delivery_request_keys ON app.food_delivery_request_keys
  TO fv_api
  USING (
    tenant_id::text = current_setting('fv.tenant', true)
    AND actor = current_setting('fv.actor', true)
  )
  WITH CHECK (
    tenant_id::text = current_setting('fv.tenant', true)
    AND actor = current_setting('fv.actor', true)
  );

GRANT SELECT, INSERT ON app.expenses TO fv_api;
GRANT SELECT ON app.members, app.companies TO fv_api;
GRANT SELECT, INSERT ON app.food_deliveries, app.food_delivery_request_keys TO fv_api;
GRANT SELECT ON app.members, app.companies TO fv_worker;
GRANT SELECT, UPDATE ON app.expenses, app.food_deliveries TO fv_worker;
GRANT SELECT ON app.members, app.companies, app.expenses, app.food_deliveries TO fv_hasura;
