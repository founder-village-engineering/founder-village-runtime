import { z } from "zod";
import { recordInput, vectorQuery, operation } from "./index.ts";
import { foodDeliveryInputSchema } from "../frontend-contracts/founder-food-deliveries/index.ts";
import {
  unversionedPublicApiContract,
  type PublicApiVersion,
} from "./api-versioning.ts";
const json = (schema: unknown) => ({ "application/json": { schema } });
const response = (
  description: string,
  schema: unknown = { type: "object" },
) => ({ description, content: json(schema) });
type PublicApiDocumentOptions = {
  contract?: PublicApiVersion;
  serverUrl?: string;
};

export function publicApiDocument(
  names: string[],
  options: PublicApiDocumentOptions = {},
) {
  const contract = options.contract ?? unversionedPublicApiContract;
  const scope = [
    {
      name: "x-application-id",
      in: "header",
      required: false,
      schema: { type: "string", enum: names, default: "founder-village" },
    },
    {
      name: "x-tenant-id",
      in: "header",
      required: true,
      schema: { type: "string", format: "uuid" },
    },
  ];
  const protectedResponses = {
    "400": response("Invalid request"),
    "401": response("Identity required"),
    "403": response("Application or tenant membership denied"),
  };
  const body = (schema: unknown) => ({ required: true, content: json(schema) });
  return {
    openapi: "3.1.0",
    info: {
      title: "Founder Village API",
      version: contract.semanticVersion,
    },
    servers: [{ url: options.serverUrl ?? "/" }],
    "x-api-contract": contract.id,
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
      schemas: {
        RecordInput: z.toJSONSchema(recordInput),
        VectorQuery: z.toJSONSchema(vectorQuery),
        FoodDeliveryInput: z.toJSONSchema(foodDeliveryInputSchema),
      },
    },
    paths: {
      "/records": {
        get: {
          summary: "List authorized tenant records",
          parameters: scope,
          responses: {
            "200": response("Records", {
              type: "array",
              items: { type: "object" },
            }),
            ...protectedResponses,
          },
        },
        post: {
          summary: "Create a record and durable outbox job",
          parameters: [
            ...scope,
            {
              name: "idempotency-key",
              in: "header",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          requestBody: body({ $ref: "#/components/schemas/RecordInput" }),
          responses: {
            "201": response("Created"),
            "200": response("Idempotent replay"),
            "409": response("Idempotency conflict"),
            ...protectedResponses,
          },
        },
      },
      "/search": {
        post: {
          summary: "Tenant-scoped vector search",
          parameters: scope,
          requestBody: body({ $ref: "#/components/schemas/VectorQuery" }),
          responses: {
            "200": response("Scoped results", {
              type: "array",
              items: { type: "object" },
            }),
            ...protectedResponses,
          },
        },
      },
      "/graphql": {
        post: {
          summary: "Source-role-scoped Hasura relay",
          parameters: scope,
          requestBody: body({
            type: "object",
            required: ["query"],
            properties: {
              query: { type: "string", maxLength: 8000 },
              variables: { type: "object" },
              operationName: { type: "string" },
            },
          }),
          responses: { "200": response("GraphQL data"), ...protectedResponses },
        },
      },
      "/applications": {
        get: {
          summary: "Configured application namespaces",
          responses: {
            "200": response("Applications", {
              type: "array",
              items: { type: "object" },
            }),
            "401": protectedResponses["401"],
          },
        },
      },
      "/files/upload": {
        post: {
          summary: "Create a short-lived scoped upload URL",
          parameters: scope,
          requestBody: body({
            type: "object",
            required: ["contentType", "size"],
            properties: {
              contentType: {
                enum: ["image/png", "image/jpeg", "application/pdf"],
              },
              size: { type: "integer", minimum: 1, maximum: 10485760 },
            },
          }),
          responses: { "200": response("Upload grant"), ...protectedResponses },
        },
      },
      "/founders/me": {
        get: {
          summary: "Read the current founder profile, companies, and balance",
          parameters: scope,
          responses: {
            "200": response("Founder profile"),
            ...protectedResponses,
          },
        },
      },
      "/expenses": {
        get: {
          summary: "List the current founder's organization expenses",
          parameters: scope,
          responses: {
            "200": response("Founder expenses", {
              type: "array",
              items: { type: "object" },
            }),
            ...protectedResponses,
          },
        },
      },
      "/food-deliveries": {
        get: {
          summary: "List the current founder's food deliveries",
          parameters: scope,
          responses: {
            "200": response("Food deliveries", {
              type: "array",
              items: { type: "object" },
            }),
            ...protectedResponses,
          },
        },
        post: {
          summary: "Record a food delivery and atomically create its expense",
          parameters: [
            ...scope,
            {
              name: "idempotency-key",
              in: "header",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          requestBody: body({
            $ref: "#/components/schemas/FoodDeliveryInput",
          }),
          responses: {
            "201": response("Food delivery and expense created"),
            "200": response("Idempotent replay"),
            "409": response("Idempotency conflict"),
            ...protectedResponses,
          },
        },
      },
    },
  };
}
export function adminApiDocument() {
  return {
    openapi: "3.1.0",
    info: { title: "Founder Village admin operations", version: "0.1.0" },
    security: [{ session: [] }],
    components: {
      securitySchemes: {
        session: { type: "apiKey", in: "cookie", name: "fv_session" },
      },
      schemas: { Operation: z.toJSONSchema(operation) },
    },
    paths: {
      "/api/operations": {
        post: {
          summary: "Request a durable, scoped operation",
          parameters: [
            {
              name: "x-csrf-token",
              in: "header",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "idempotency-key",
              in: "header",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          requestBody: {
            required: true,
            content: json({ $ref: "#/components/schemas/Operation" }),
          },
          responses: {
            "202": response("Queued locally or awaiting fresh production MFA"),
            "401": response("Identity required"),
            "403": response("Grant or request-origin denied"),
            "409": response("Idempotency conflict"),
          },
        },
      },
    },
  };
}
