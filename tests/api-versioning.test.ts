import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type pg from "pg";
import { api } from "../services/api/app.ts";
import { localToken } from "../packages/auth/index.ts";
import {
  publicApiVersions,
  unversionedPublicApiContract,
  type PublicApiVersion,
} from "../packages/contracts/api-versioning.ts";
import { installApiVersionHeaders } from "../services/api/versioning.ts";

test("deprecated contracts emit machine-readable lifecycle headers", async (t) => {
  const deprecatedAt = "2026-01-02T03:04:05.000Z";
  const sunsetAt = "2027-02-03T04:05:06.000Z";
  const deprecated: PublicApiVersion = {
    id: "v0",
    semanticVersion: "0.9.0",
    basePath: "/v0",
    openApiPath: "/v0/openapi.json",
    status: "deprecated",
    deprecatedAt,
    sunsetAt,
    successor: "v1",
  };
  const app = Fastify();
  installApiVersionHeaders(app, deprecated);
  app.get("/resource", async () => ({ ok: true }));
  t.after(() => app.close());

  const response = await app.inject({ url: "/resource" });
  assert.equal(response.headers["api-version"], "v0");
  assert.equal(
    response.headers.deprecation,
    `@${Math.floor(Date.parse(deprecatedAt) / 1000)}`,
  );
  assert.equal(response.headers.sunset, new Date(sunsetAt).toUTCString());
  assert.equal(response.headers.link, '</v1>; rel="successor-version"');
});

test("API publishes a stable v1 contract without replacing unversioned routes", async (t) => {
  const settings = {
    FV_ENV: "local",
    OIDC_ISSUER: "https://synthetic.fv.test",
    OIDC_AUDIENCE: "fv-version-test",
    LOCAL_JWT_SECRET: "synthetic-local-signing-key-longer-than-32-bytes",
  };
  const previous = Object.fromEntries(
    Object.keys(settings).flatMap((key) => [
      [key, process.env[key]],
      [`${key}_FILE`, process.env[`${key}_FILE`]],
    ]),
  );
  for (const [key, value] of Object.entries(settings)) {
    process.env[key] = value;
    delete process.env[`${key}_FILE`];
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const client = {
    async query(sql: string) {
      return {
        rows: sql.includes("app.is_member") ? [{ allowed: false }] : [],
        rowCount: 0,
      };
    },
    release() {},
  };
  const database = {
    ...client,
    async connect() {
      return client;
    },
  } as unknown as pg.Pool;
  const app = await api(database);
  t.after(() => app.close());

  assert.deepEqual(
    publicApiVersions.map((version) => version.id),
    ["v1"],
  );
  assert.equal(unversionedPublicApiContract.id, "v1");
  assert.equal(
    new Set(publicApiVersions.map((version) => version.id)).size,
    publicApiVersions.length,
  );
  for (const version of publicApiVersions) {
    assert.match(version.id, /^v[1-9][0-9]*$/);
    assert.equal(version.basePath, `/${version.id}`);
    assert.equal(version.openApiPath, `${version.basePath}/openapi.json`);
    assert.equal(
      Number(version.semanticVersion.split(".")[0]),
      Number(version.id.slice(1)),
    );
  }

  const catalog = await app.inject({ url: "/api/versions" });
  assert.equal(catalog.statusCode, 200, catalog.body);
  assert.deepEqual(catalog.json(), {
    strategy: "url-major",
    unversioned: {
      basePath: "/",
      contract: "v1",
      policy: "backward-compatible",
    },
    versions: [
      {
        id: "v1",
        semanticVersion: "1.0.0",
        basePath: "/v1",
        openApiPath: "/v1/openapi.json",
        status: "stable",
      },
    ],
  });

  const unversioned = await app.inject({ url: "/records" });
  const v1 = await app.inject({ url: "/v1/records" });
  assert.equal(unversioned.statusCode, 401, unversioned.body);
  assert.equal(v1.statusCode, 401, v1.body);
  assert.equal(unversioned.headers["api-version"], "v1");
  assert.equal(v1.headers["api-version"], "v1");
  assert.deepEqual(v1.json().error, unversioned.json().error);

  const authorization = `Bearer ${await localToken("version-client")}`;
  const rootApplications = await app.inject({
    url: "/applications",
    headers: { authorization },
  });
  const v1Applications = await app.inject({
    url: "/v1/applications",
    headers: { authorization },
  });
  assert.equal(rootApplications.statusCode, 200, rootApplications.body);
  assert.equal(v1Applications.statusCode, 200, v1Applications.body);
  assert.deepEqual(v1Applications.json(), rootApplications.json());

  const tenantHeaders = {
    authorization,
    "x-tenant-id": "11111111-1111-4111-8111-111111111111",
  };
  const deniedRoot = await app.inject({
    url: "/records",
    headers: tenantHeaders,
  });
  const deniedV1 = await app.inject({
    url: "/v1/records",
    headers: tenantHeaders,
  });
  assert.equal(deniedRoot.statusCode, 403, deniedRoot.body);
  assert.equal(deniedV1.statusCode, 403, deniedV1.body);
  assert.deepEqual(deniedV1.json().error, deniedRoot.json().error);

  const rootDocument = await app.inject({ url: "/openapi.json" });
  const v1Document = await app.inject({ url: "/v1/openapi.json" });
  assert.equal(rootDocument.statusCode, 200, rootDocument.body);
  assert.equal(v1Document.statusCode, 200, v1Document.body);
  assert.equal(rootDocument.headers["api-version"], "v1");
  assert.equal(v1Document.headers["api-version"], "v1");
  assert.equal(rootDocument.json().info.version, "1.0.0");
  assert.equal(v1Document.json().info.version, "1.0.0");
  assert.deepEqual(rootDocument.json().servers, [{ url: "/" }]);
  assert.deepEqual(v1Document.json().servers, [{ url: "/v1" }]);
  assert.deepEqual(v1Document.json().paths, rootDocument.json().paths);
});
