import { test } from "node:test";
import assert from "node:assert/strict";
import { boundedJson } from "../packages/observability/http.ts";
import { server } from "../packages/observability/index.ts";

test("private JSON responses and failures cannot be cached or expose raw errors", async () => {
  const app = await server("http-hardening");
  app.get("/private", async () => ({
    url: "https://files.example/synthetic-signed-url",
  }));
  app.get("/failed", async () => {
    throw Object.assign(new Error("synthetic-secret-diagnostic"), {
      statusCode: 503,
    });
  });
  app.get("/invalid-status", async () => {
    throw Object.assign(new Error("synthetic-secret-diagnostic"), {
      statusCode: 999,
    });
  });
  try {
    for (const [url, status] of [
      ["/private", 200],
      ["/failed", 503],
      ["/invalid-status", 500],
      ["/missing", 404],
    ] as const) {
      const result = await app.inject({ url });
      assert.equal(result.statusCode, status);
      assert.equal(result.headers["cache-control"], "no-store");
      assert(!result.body.includes("synthetic-secret-diagnostic"));
      if (status >= 500) assert.equal(result.json().error, "internal_error");
    }
  } finally {
    await app.close();
  }
});

test("upstream JSON enforces byte budgets and cancels oversized streams", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"value":"oversized"}'));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await assert.rejects(
    () => boundedJson(response, 5),
    /response limit exceeded/,
  );
  assert(cancelled);
  assert.equal(response.body!.locked, false);
  assert.deepEqual(await boundedJson(new Response('{"x":1}'), 7), { x: 1 });
  for (const limit of [0, -1, NaN, Infinity, 0.5])
    await assert.rejects(
      () => boundedJson(new Response("{}"), limit),
      /invalid response limit/,
    );
  await assert.rejects(() => boundedJson(new Response("invalid")), SyntaxError);
});
