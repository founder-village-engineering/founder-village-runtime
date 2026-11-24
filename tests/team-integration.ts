import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type pg from "pg";
import { local, localToken } from "../packages/auth/index.ts";
import { pool } from "../packages/database/index.ts";
import { applicationId } from "../packages/frontend-contracts/founder-village-team/index.ts";
import { sealTeamPayload } from "../services/api/team/crypto.ts";
import { api } from "../services/api/app.ts";

export async function exerciseTeam(db: pg.Pool, migrator: pg.Pool) {
  if (!local()) throw new Error("local fixtures required");
  const app = await api({ [applicationId]: db });
  const tenantId = randomUUID(),
    alice = randomUUID(),
    bob = randomUUID(),
    outsider = randomUUID();
  const auth = async (subject: string): Promise<Record<string, string>> => ({
    Authorization: `Bearer ${await localToken(subject)}`,
    "x-application-id": applicationId,
    "x-tenant-id": tenantId,
  });
  const [a, b, o] = await Promise.all([auth(alice), auth(bob), auth(outsider)]);
  const path = "/v1/team",
    actor = (name: string) => `${process.env.OIDC_ISSUER}|${name}`;
  const post = (
    url: string,
    payload: Record<string, unknown>,
    headers = a,
    key: string = randomUUID(),
  ) =>
    app.inject({
      url: path + url,
      method: "POST",
      payload,
      headers: { ...headers, "idempotency-key": key },
    });
  const get = (url: string, headers = a) =>
    app.inject({ url: path + url, method: "GET", headers });
  const original = globalThis.fetch;
  const oldKey = process.env.TEAM_XAI_API_KEY,
    oldFile = process.env.TEAM_XAI_API_KEY_FILE,
    oldModel = process.env.TEAM_XAI_MODEL;
  try {
    await migrator.query(
      "INSERT INTO app.tenants(id,name) VALUES ($1,'Synthetic integration')",
      [tenantId],
    );
    await migrator.query(
      "INSERT INTO app.memberships(tenant_id,actor) VALUES ($1,$2),($1,$3)",
      [tenantId, actor(alice), actor(bob)],
    );
    assert.equal(
      (await app.inject({ url: path + "/tenants" })).statusCode,
      401,
    );
    assert.deepEqual((await get("/tenants", o)).json(), []);
    assert.equal((await get("/conversations", o)).statusCode, 403);
    assert.equal(
      (await get("/bots", { ...a, "x-application-id": "founders" })).statusCode,
      403,
    );
    const portal = { ...a, origin: "http://127.0.0.1:43913" };
    const work = "/engineering/items";
    const inputItem = {
      title: "Synthetic engineering task",
      detail: "Track the synthetic release.",
    };
    assert.equal((await post(work, { title: " " }, portal)).statusCode, 400);
    const itemKey = randomUUID();
    const attempts = await Promise.all([
      post(work, inputItem, portal, itemKey),
      post(work, inputItem, portal, itemKey),
    ]);
    const item = attempts[0]!.json();
    assert.equal(attempts[0]!.statusCode, 200);
    assert.deepEqual(attempts[1]!.json(), item);
    assert.equal(item.status, "backlog");
    const statusPath = `${work}/${item.id}/status`;
    assert.equal(
      (await post(work, { ...inputItem, title: "Changed" }, portal, itemKey))
        .statusCode,
      409,
    );
    assert.equal(
      (await get(work, { ...o, origin: portal.origin })).statusCode,
      403,
    );
    assert.equal(
      (await post(statusPath, { status: "done", revision: 1 }, o)).statusCode,
      403,
    );
    const startKey = randomUUID();
    const startWork = { status: "in_progress", revision: 1 };
    const started = await post(statusPath, startWork, portal, startKey);
    assert.equal(started.statusCode, 200);
    assert.equal(started.json().revision, 2);
    assert.equal(
      (await post(statusPath, { status: "done", revision: 1 }, b)).statusCode,
      409,
    );
    const done = await post(statusPath, { status: "done", revision: 2 }, b);
    assert.equal(done.statusCode, 200);
    assert.equal(done.json().status, "done");
    assert.deepEqual((await get(work, portal)).json().items, [done.json()]);
    assert.deepEqual(
      (await post(statusPath, startWork, portal, startKey)).json(),
      started.json(),
    );
    const history = await migrator.query<{
      actor: string;
      request_id: string;
      payload: Buffer;
    }>(
      "SELECT actor,request_id,payload FROM app.team_engineering_history WHERE tenant_id=$1 AND item_id=$2 ORDER BY revision",
      [tenantId, item.id],
    );
    assert.deepEqual(
      history.rows.map((row) => row.actor),
      [actor(alice), actor(alice), actor(bob)],
    );
    assert(
      history.rows.every(
        (row) => row.request_id && !row.payload.includes(inputItem.detail),
      ),
    );
    await assert.rejects(
      () => db.query("SELECT actor FROM app.team_engineering_history"),
      { code: "42501" },
    );
    delete process.env.TEAM_XAI_API_KEY;
    delete process.env.TEAM_XAI_API_KEY_FILE;
    assert.deepEqual((await get("/capabilities")).json(), {
      repliesAvailable: false,
    });
    const botInput = {
      name: "Synthetic guide",
      instructions: "Synthetic internal instructions.",
      visibility: "team",
    };
    const botResponse = await post("/bots", botInput, portal);
    assert.equal(botResponse.statusCode, 200);
    const bot = botResponse.json();
    const directory = (await get("/bots?view=directory")).json().items[0];
    assert.equal(directory.canManage, true);
    assert.equal(directory.instructions, null);
    assert.equal(directory.configuration, null);
    assert.deepEqual(
      (await get("/bots/" + bot.id + "?view=directory")).json(),
      directory,
    );
    assert.equal(
      (await get("/bots/" + bot.id)).json().instructions,
      botInput.instructions,
    );
    await post("/bots", { ...botInput, visibility: "private" });
    const shared = (await get("/bots", b)).json().items;
    assert.equal(shared.length, 1);
    assert.equal(shared[0].instructions, null);
    assert.equal(shared[0].configuration, null);
    assert.equal(shared[0].canManage, false);
    const edit = {
      name: "Updated guide",
      instructions: "Updated synthetic instructions.",
    };
    assert.equal((await post("/bots/" + bot.id, edit, b)).statusCode, 403);
    assert.equal((await post("/bots/" + bot.id, edit)).json().name, edit.name);
    assert.equal(
      (
        await migrator.query(
          "SELECT count(*) FROM app.team_bot_history WHERE tenant_id=$1 AND bot_id=$2",
          [tenantId, bot.id],
        )
      ).rows[0].count,
      "2",
    );
    const create = await post(
      "/conversations",
      {
        title: "Synthetic chat",
        botId: bot.id,
      },
      portal,
    );
    assert.equal(create.statusCode, 200);
    const chat = create.json().id as string;
    const messages = "/conversations/" + chat + "/messages",
      replies = "/conversations/" + chat + "/replies";
    const key = randomUUID(),
      input = { content: "Synthetic private message" };
    const results = await Promise.all([
      post(messages, input, a, key),
      post(messages, input, a, key),
    ]);
    assert.equal(results[0]!.statusCode, 200);
    assert.deepEqual(results[0]!.json(), results[1]!.json());
    const msg = results[0]!.json();
    assert.equal(
      (await post(messages, { content: "Different" }, a, key)).statusCode,
      409,
    );
    assert.equal((await get("/conversations", b)).json().items.length, 0);
    assert.equal((await get(messages, b)).statusCode, 404);
    assert.equal((await post(messages, input, b)).statusCode, 404);
    assert.equal(
      (await post(replies, { messageId: msg.id }, b)).statusCode,
      404,
    );
    assert.equal((await post(replies, { messageId: msg.id })).statusCode, 503);
    const stored = await migrator.query(
      "SELECT payload FROM app.team_messages WHERE tenant_id=$1 AND id=$2",
      [tenantId, msg.id],
    );
    assert(!Buffer.from(stored.rows[0].payload).includes(input.content));
    let calls = 0;
    process.env.TEAM_XAI_API_KEY = "synthetic-unusable";
    process.env.TEAM_XAI_MODEL = "synthetic-model";
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "https://api.x.ai/v1/chat/completions");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.messages[0].content, edit.instructions);
      assert.equal(body.messages.at(-1).content, input.content);
      assert.equal(body.tools, undefined);
      calls++;
      return Response.json({
        choices: [{ message: { content: "Synthetic response" } }],
      });
    };
    const replyKey = randomUUID(),
      replyInput = { messageId: msg.id };
    const [r1, r2] = await Promise.all([
      post(replies, replyInput, a, replyKey),
      post(replies, replyInput),
    ]);
    const delivered = [r1, r2].find((result) => result.statusCode === 200);
    assert.ok(delivered);
    assert.ok(
      [r1, r2].every((result) => [200, 409].includes(result.statusCode)),
    );
    assert.deepEqual(
      (await post(replies, replyInput, a, replyKey)).json(),
      delivered.json(),
    );
    assert.equal(calls, 1);
    for (let index = 0; index < 35; index++)
      assert.equal(
        (await post(messages, { content: "Synthetic turn " + index }))
          .statusCode,
        200,
      );
    const first = (await get(messages)).json(),
      second = (await get(messages + "?after=" + first.next)).json();
    assert.equal(first.items.length, 35);
    assert.equal(first.items[0].content, input.content);
    assert.equal(first.items[1].role, "assistant");
    assert.deepEqual(
      second.items.map((x: { position: number }) => x.position),
      [36, 37],
    );
    assert.equal(second.next, null);
    const descending = (await get(messages + "?order=newest")).json();
    assert.deepEqual(
      descending.items.map((item: { position: number }) => item.position),
      Array.from({ length: 35 }, (_, index) => 37 - index),
    );
    const older = (
      await get(messages + "?order=newest&after=" + descending.next)
    ).json();
    assert.deepEqual(
      older.items.map((item: { position: number }) => item.position),
      [2, 1],
    );
    assert.equal(older.next, null);
    assert.equal((await get("/conversations/" + chat, b)).statusCode, 404);
    assert.equal((await get("/conversations/" + chat)).json().id, chat);
    assert.equal((await get("/bots/" + bot.id, b)).json().instructions, null);
    const lastId = second.items.at(-1).id,
      latest = { messageId: lastId };
    globalThis.fetch = async () => new Response(null, { status: 429 });
    assert.equal((await post(replies, latest)).statusCode, 502);
    let uncertainCalls = 0;
    globalThis.fetch = async () => {
      uncertainCalls++;
      throw new Error("synthetic ambiguous delivery");
    };
    assert.equal((await post(replies, latest)).statusCode, 502);
    assert.equal((await post(replies, latest)).statusCode, 409);
    assert.equal(uncertainCalls, 1);
    // Archives may contain a single message larger than the shared browser JSON limit.
    const hugeId = randomUUID(),
      hugeContent = "🪴\u0000".repeat(140000),
      fullName = "Synthetic author".repeat(6000);
    await migrator.query(
      "INSERT INTO app.team_messages(tenant_id,conversation_id,id,position,role,payload) VALUES($1,$2,$3,38,'tool',$4)",
      [
        tenantId,
        chat,
        hugeId,
        sealTeamPayload(tenantId, "message", hugeId, {
          content: hugeContent,
          authorName: fullName,
        }),
      ],
    );
    const hugePage = await get(messages + "?order=newest");
    assert.ok(hugePage.rawPayload.length <= 1_048_576);
    const {
      items: [preview],
      next,
    } = hugePage.json();
    assert.equal(preview.id, hugeId);
    assert.equal(next, hugeId);
    let { content, authorName, nextOffset } = preview;
    const chunkPath = messages + "/" + hugeId + "/content?offset=";
    assert.equal((await get(chunkPath + nextOffset, b)).statusCode, 404);
    while (nextOffset !== null) {
      assert.ok(Number.isSafeInteger(nextOffset));
      const result = await get(chunkPath + nextOffset);
      assert.equal(result.statusCode, 200);
      assert.ok(result.rawPayload.length <= 1_048_576);
      const chunk = result.json();
      assert.ok(chunk.nextOffset === null || chunk.nextOffset > nextOffset);
      content += chunk.content;
      authorName += chunk.authorName;
      nextOffset = chunk.nextOffset;
    }
    assert.ok(content === hugeContent && authorName === fullName);
    assert.deepEqual(
      (await get(messages + "?order=newest&after=" + next)).json(),
      descending,
    );
    // Each of these messages fits alone, but combining them would overflow a page.
    const regularLarge = "林".repeat(190000),
      largeIds = [randomUUID(), randomUUID()];
    for (const [index, id] of largeIds.entries()) {
      await migrator.query(
        "INSERT INTO app.team_messages(tenant_id,conversation_id,id,position,role,payload) VALUES($1,$2,$3,$4,'assistant',$5)",
        [
          tenantId,
          chat,
          id,
          39 + index,
          sealTeamPayload(tenantId, "message", id, { content: regularLarge }),
        ],
      );
    }
    let cursor = "";
    for (const expected of [...largeIds].reverse()) {
      const response = await get(messages + "?order=newest" + cursor);
      assert.ok(response.rawPayload.length <= 1_048_576);
      const segment = response.json();
      assert.deepEqual(
        segment.items.map((row: { id: string }) => row.id),
        [expected],
      );
      assert.equal(segment.items[0].content.length, regularLarge.length);
      assert.equal(segment.items[0].nextOffset, undefined);
      assert.equal(segment.next, expected);
      cursor = "&after=" + segment.next;
    }
    await migrator.query(
      "UPDATE app.memberships SET enabled=false WHERE tenant_id=$1 AND actor=$2",
      [tenantId, actor(alice)],
    );
    assert.equal((await get(messages)).statusCode, 403);
  } finally {
    globalThis.fetch = original;
    for (const [name, value] of [
      ["TEAM_XAI_API_KEY", oldKey],
      ["TEAM_XAI_API_KEY_FILE", oldFile],
      ["TEAM_XAI_MODEL", oldModel],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await app.close();
    // Remove the isolated fixture's access grants even when an assertion fails.
    await migrator.query("DELETE FROM app.memberships WHERE tenant_id=$1", [
      tenantId,
    ]);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const db = pool("FOUNDER_VILLAGE_TEAM_DATABASE_URL"),
    migrator = pool("MIGRATION_FOUNDER_VILLAGE_TEAM_DATABASE_URL");
  try {
    await exerciseTeam(db, migrator);
    console.log("Team API PostgreSQL integration passed.");
  } finally {
    await Promise.all([db.end(), migrator.end()]);
  }
}
