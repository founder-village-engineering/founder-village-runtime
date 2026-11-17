import { test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { transaction } from "../packages/database/index.ts";
import { migrate } from "../packages/database/migrate.ts";

function fixture(
  history: { name: string; checksum: string }[] = [],
  rollbackFails = false,
) {
  const calls: string[] = [];
  const releases: boolean[] = [];
  const client = {
    async query(sql: string) {
      calls.push(sql);
      if (sql === "ROLLBACK" && rollbackFails) throw new Error("rollback lost");
      return {
        rows:
          sql === "SELECT name,checksum FROM public.fv_migrations"
            ? history
            : [],
        rowCount: 0,
      };
    },
    release(discard: boolean) {
      releases.push(discard);
    },
  };
  const db = {
    async connect() {
      return client;
    },
  } as unknown as pg.Pool;
  return { db, calls, releases };
}

test("failed rollback discards connection and preserves the original failure", async () => {
  const { db, calls, releases } = fixture([], true);
  const original = new Error("original operation failed");
  await assert.rejects(
    transaction(db, async () => {
      throw original;
    }),
    (e) => e === original,
  );
  assert.deepEqual(calls, ["BEGIN", "ROLLBACK"]);
  assert.deepEqual(releases, [true]);
});

test("successful rollback and commit keep reusable connections", async () => {
  const { db, calls, releases } = fixture();
  await assert.rejects(
    transaction(db, async () => {
      throw new Error("expected");
    }),
  );
  assert.equal(await transaction(db, async () => 42), 42);
  assert.deepEqual(calls, ["BEGIN", "ROLLBACK", "BEGIN", "COMMIT"]);
  assert.deepEqual(releases, [false, false]);
});

test("removed shared and application migrations fail before applying new SQL", async () => {
  for (const name of ["000_app.sql", "founder-village/001_removed.sql"]) {
    const { db, calls } = fixture([{ name, checksum: "a".repeat(64) }]);
    await assert.rejects(migrate(db, "app"), /missing from source inventory/);
    assert.equal(calls.at(-1), "ROLLBACK");
    assert(
      !calls.some((sql) => sql.startsWith("INSERT INTO public.fv_migrations")),
    );
    assert(!calls.some((sql) => sql.includes("CREATE SCHEMA")));
  }
});

test("changed applied migrations fail checksum verification", async () => {
  const { db, calls } = fixture([{ name: "001_app.sql", checksum: "invalid" }]);
  await assert.rejects(migrate(db, "app"), /checksum mismatch/);
  assert.equal(calls.at(-1), "ROLLBACK");
  assert(
    !calls.some((sql) => sql.startsWith("INSERT INTO public.fv_migrations")),
  );
});
