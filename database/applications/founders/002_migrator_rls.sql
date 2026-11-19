-- FORCE ROW LEVEL SECURITY also applies to the table owner. The founders
-- migrator already owns this database; make its controlled data migrations and
-- local fixture seeding explicit without weakening API, worker, or Hasura RLS.
CREATE POLICY founders_migrator_members ON app.members
  TO fv_founders_migrator USING (true) WITH CHECK (true);

CREATE POLICY founders_migrator_companies ON app.companies
  TO fv_founders_migrator USING (true) WITH CHECK (true);

CREATE POLICY founders_migrator_expenses ON app.expenses
  TO fv_founders_migrator USING (true) WITH CHECK (true);

CREATE POLICY founders_migrator_food_deliveries ON app.food_deliveries
  TO fv_founders_migrator USING (true) WITH CHECK (true);

CREATE POLICY founders_migrator_food_delivery_request_keys
  ON app.food_delivery_request_keys
  TO fv_founders_migrator USING (true) WITH CHECK (true);
