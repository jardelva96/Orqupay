import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "../../..");

const openApiPath = path.join(root, "contracts/openapi/payment-module.v1.yaml");
const asyncApiPath = path.join(root, "contracts/asyncapi/payment-events.v1.yaml");
const schemaPaths = [
  path.join(root, "schemas/payment-intent.v1.json"),
  path.join(root, "schemas/webhook-event.v1.json"),
];

function fail(message) {
  console.error(`contracts:check failed: ${message}`);
  process.exit(1);
}

function ensure(condition, message) {
  if (!condition) {
    fail(message);
  }
}

const openApiRaw = await readFile(openApiPath, "utf8");
const openApi = yaml.load(openApiRaw);
ensure(openApi && typeof openApi === "object", "OpenAPI file is not a valid YAML object.");
ensure(String(openApi.openapi ?? "").startsWith("3."), "OpenAPI version must be 3.x.");
ensure(openApi.paths && typeof openApi.paths === "object", "OpenAPI paths section missing.");
ensure(Array.isArray(openApi.security), "OpenAPI global security section missing.");
ensure(
  openApi.components?.securitySchemes?.bearerAuth?.type === "http",
  "OpenAPI bearerAuth security scheme missing or invalid.",
);
for (const requiredPath of [
  "/health/live",
  "/health/ready",
  "/metrics",
  "/v1/payment-intents",
  "/v1/payment-intents/{id}/confirm",
  "/v1/payment-intents/{id}/capture",
  "/v1/payment-intents/{id}/cancel",
  "/v1/refunds",
  "/v1/chargebacks",
  "/v1/chargebacks/{id}/resolve",
  "/v1/reconciliation/summary",
  "/v1/payment-events",
  "/v1/webhook-endpoints",
  "/v1/webhook-endpoints/{id}",
  "/v1/webhook-endpoints/{id}/rotate-secret",
  "/v1/webhook-deliveries",
  "/v1/webhook-dead-letters",
  "/v1/webhook-dead-letters/{id}",
  "/v1/webhook-dead-letters/{id}/replay",
  "/v1/webhook-dead-letters/replay-batch",
]) {
  ensure(Boolean(openApi.paths?.[requiredPath]), `OpenAPI required path missing: '${requiredPath}'.`);
}
ensure(Boolean(openApi.paths?.["/v1/payment-intents"]?.get), "OpenAPI operation GET /v1/payment-intents missing.");
for (const pathKey of ["/health/live", "/health/ready", "/metrics"]) {
  const operation = openApi.paths?.[pathKey]?.get;
  ensure(Boolean(operation), `OpenAPI operation GET ${pathKey} missing.`);
  ensure(Array.isArray(operation?.security) && operation.security.length === 0, `${pathKey} must be public.`);
}

function hasRequiredIdempotencyHeader(operation) {
  const parameters = operation?.parameters ?? [];
  return parameters.some(
    (item) =>
      item?.in === "header" &&
      item?.name === "Idempotency-Key" &&
      item?.required === true &&
      item?.schema?.type === "string" &&
      item?.schema?.maxLength === 128 &&
      item?.schema?.pattern === "^[A-Za-z0-9._:-]+$",
  );
}

function hasResponseHeaderRef(operation, statusCode, headerName, expectedRef) {
  return operation?.responses?.[statusCode]?.headers?.[headerName]?.$ref === expectedRef;
}

function hasQueryParameter(operation, name, assertions) {
  const parameters = operation?.parameters ?? [];
  return parameters.some((item) => {
    if (item?.in !== "query" || item?.name !== name) {
      return false;
    }
    for (const [key, expected] of Object.entries(assertions)) {
      if (item?.schema?.[key] !== expected) {
        return false;
      }
    }
    return true;
  });
}

for (const [pathKey, method] of [
  ["/v1/payment-intents", "post"],
  ["/v1/payment-intents/{id}/confirm", "post"],
  ["/v1/payment-intents/{id}/capture", "post"],
  ["/v1/payment-intents/{id}/cancel", "post"],
  ["/v1/refunds", "post"],
  ["/v1/chargebacks", "post"],
  ["/v1/chargebacks/{id}/resolve", "post"],
]) {
  const operation = openApi.paths?.[pathKey]?.[method];
  ensure(
    hasRequiredIdempotencyHeader(operation),
    `OpenAPI operation ${method.toUpperCase()} ${pathKey} must require Idempotency-Key header.`,
  );
  ensure(
    Boolean(operation?.responses?.["422"]),
    `OpenAPI operation ${method.toUpperCase()} ${pathKey} must define 422 response for invalid idempotency key.`,
  );
}

for (const [pathKey, method, successStatus] of [
  ["/v1/payment-intents", "post", "201"],
  ["/v1/payment-intents/{id}/confirm", "post", "200"],
  ["/v1/payment-intents/{id}/capture", "post", "200"],
  ["/v1/payment-intents/{id}/cancel", "post", "200"],
  ["/v1/refunds", "post", "201"],
  ["/v1/chargebacks", "post", "201"],
  ["/v1/chargebacks/{id}/resolve", "post", "200"],
]) {
  const operation = openApi.paths?.[pathKey]?.[method];
  ensure(
    hasResponseHeaderRef(
      operation,
      successStatus,
      "X-Idempotency-Replayed",
      "#/components/headers/IdempotencyReplayed",
    ),
    `OpenAPI operation ${method.toUpperCase()} ${pathKey} must expose X-Idempotency-Replayed header.`,
  );
  ensure(
    hasResponseHeaderRef(
      operation,
      successStatus,
      "Idempotency-Key",
      "#/components/headers/IdempotencyKeyEcho",
    ),
    `OpenAPI operation ${method.toUpperCase()} ${pathKey} must expose Idempotency-Key response header.`,
  );
}

for (const pathKey of [
  "/v1/payment-intents",
  "/v1/refunds",
  "/v1/chargebacks",
  "/v1/payment-events",
  "/v1/webhook-endpoints",
  "/v1/webhook-deliveries",
  "/v1/webhook-dead-letters",
]) {
  const operation = openApi.paths?.[pathKey]?.get;
  ensure(Boolean(operation), `OpenAPI operation GET ${pathKey} missing.`);
  ensure(
    hasQueryParameter(operation, "limit", { type: "integer", minimum: 1, maximum: 5000 }),
    `OpenAPI operation GET ${pathKey} must define query param 'limit' (1..5000).`,
  );
  ensure(
    hasQueryParameter(operation, "cursor", {
      type: "string",
      minLength: 1,
      maxLength: 512,
      pattern: "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$",
    }),
    `OpenAPI operation GET ${pathKey} must define query param 'cursor' with expected pattern.`,
  );
}
const paymentIntentListOperation = openApi.paths?.["/v1/payment-intents"]?.get;
ensure(Boolean(paymentIntentListOperation), "OpenAPI operation GET /v1/payment-intents missing.");
ensure(
  hasQueryParameter(paymentIntentListOperation, "currency", { type: "string", pattern: "^[A-Za-z]{3}$" }),
  "OpenAPI operation GET /v1/payment-intents must define query param 'currency'.",
);
ensure(
  hasQueryParameter(paymentIntentListOperation, "amount_min", { type: "integer", minimum: 1 }),
  "OpenAPI operation GET /v1/payment-intents must define query param 'amount_min'.",
);
ensure(
  hasQueryParameter(paymentIntentListOperation, "amount_max", { type: "integer", minimum: 1 }),
  "OpenAPI operation GET /v1/payment-intents must define query param 'amount_max'.",
);
ensure(
  hasQueryParameter(paymentIntentListOperation, "status", { type: "string" }),
  "OpenAPI operation GET /v1/payment-intents must define query param 'status'.",
);
ensure(
  hasQueryParameter(paymentIntentListOperation, "customer_id", {
    type: "string",
    minLength: 1,
    maxLength: 255,
  }),
  "OpenAPI operation GET /v1/payment-intents must define query param 'customer_id'.",
);
ensure(
  hasQueryParameter(paymentIntentListOperation, "provider", {
    type: "string",
    minLength: 1,
    maxLength: 255,
  }),
  "OpenAPI operation GET /v1/payment-intents must define query param 'provider'.",
);
ensure(
  hasQueryParameter(paymentIntentListOperation, "provider_reference", {
    type: "string",
    minLength: 1,
    maxLength: 255,
  }),
  "OpenAPI operation GET /v1/payment-intents must define query param 'provider_reference'.",
);
ensure(
  hasQueryParameter(paymentIntentListOperation, "payment_method_type", { type: "string" }),
  "OpenAPI operation GET /v1/payment-intents must define query param 'payment_method_type'.",
);
ensure(
  hasQueryParameter(paymentIntentListOperation, "created_from", { type: "string", format: "date-time" }),
  "OpenAPI operation GET /v1/payment-intents must define query param 'created_from'.",
);
ensure(
  hasQueryParameter(paymentIntentListOperation, "created_to", { type: "string", format: "date-time" }),
  "OpenAPI operation GET /v1/payment-intents must define query param 'created_to'.",
);
ensure(
  Boolean(paymentIntentListOperation?.responses?.["422"]),
  "OpenAPI operation GET /v1/payment-intents must define 422 response.",
);
const refundsListOperation = openApi.paths?.["/v1/refunds"]?.get;
ensure(Boolean(refundsListOperation), "OpenAPI operation GET /v1/refunds missing.");
ensure(
  hasQueryParameter(refundsListOperation, "payment_intent_id", {
    type: "string",
    minLength: 1,
    maxLength: 255,
  }),
  "OpenAPI operation GET /v1/refunds must define query param 'payment_intent_id'.",
);
ensure(
  hasQueryParameter(refundsListOperation, "amount_min", { type: "integer", minimum: 1 }),
  "OpenAPI operation GET /v1/refunds must define query param 'amount_min'.",
);
ensure(
  hasQueryParameter(refundsListOperation, "amount_max", { type: "integer", minimum: 1 }),
  "OpenAPI operation GET /v1/refunds must define query param 'amount_max'.",
);
ensure(
  hasQueryParameter(refundsListOperation, "status", { type: "string" }),
  "OpenAPI operation GET /v1/refunds must define query param 'status'.",
);
ensure(
  hasQueryParameter(refundsListOperation, "created_from", { type: "string", format: "date-time" }),
  "OpenAPI operation GET /v1/refunds must define query param 'created_from'.",
);
ensure(
  hasQueryParameter(refundsListOperation, "created_to", { type: "string", format: "date-time" }),
  "OpenAPI operation GET /v1/refunds must define query param 'created_to'.",
);
ensure(
  Boolean(refundsListOperation?.responses?.["422"]),
  "OpenAPI operation GET /v1/refunds must define 422 response.",
);
const chargebacksListOperation = openApi.paths?.["/v1/chargebacks"]?.get;
ensure(Boolean(chargebacksListOperation), "OpenAPI operation GET /v1/chargebacks missing.");
ensure(
  hasQueryParameter(chargebacksListOperation, "payment_intent_id", {
    type: "string",
    minLength: 1,
    maxLength: 255,
  }),
  "OpenAPI operation GET /v1/chargebacks must define query param 'payment_intent_id'.",
);
ensure(
  hasQueryParameter(chargebacksListOperation, "status", { type: "string" }),
  "OpenAPI operation GET /v1/chargebacks must define query param 'status'.",
);
ensure(
  hasQueryParameter(chargebacksListOperation, "created_from", { type: "string", format: "date-time" }),
  "OpenAPI operation GET /v1/chargebacks must define query param 'created_from'.",
);
ensure(
  hasQueryParameter(chargebacksListOperation, "created_to", { type: "string", format: "date-time" }),
  "OpenAPI operation GET /v1/chargebacks must define query param 'created_to'.",
);
ensure(
  Boolean(chargebacksListOperation?.responses?.["422"]),
  "OpenAPI operation GET /v1/chargebacks must define 422 response.",
);
const reconciliationSummaryOperation = openApi.paths?.["/v1/reconciliation/summary"]?.get;
ensure(Boolean(reconciliationSummaryOperation), "OpenAPI operation GET /v1/reconciliation/summary missing.");
ensure(
  hasQueryParameter(reconciliationSummaryOperation, "currency", {
    type: "string",
    pattern: "^[A-Za-z]{3}$",
  }),
  "OpenAPI operation GET /v1/reconciliation/summary must define query param 'currency'.",
);
ensure(
  hasQueryParameter(reconciliationSummaryOperation, "created_from", { type: "string", format: "date-time" }),
  "OpenAPI operation GET /v1/reconciliation/summary must define query param 'created_from'.",
);
ensure(
  hasQueryParameter(reconciliationSummaryOperation, "created_to", { type: "string", format: "date-time" }),
  "OpenAPI operation GET /v1/reconciliation/summary must define query param 'created_to'.",
);
ensure(
  Boolean(reconciliationSummaryOperation?.responses?.["422"]),
  "OpenAPI operation GET /v1/reconciliation/summary must define 422 response.",
);
const paymentEventsListOperation = openApi.paths?.["/v1/payment-events"]?.get;
ensure(Boolean(paymentEventsListOperation), "OpenAPI operation GET /v1/payment-events missing.");
ensure(
  hasQueryParameter(paymentEventsListOperation, "payment_intent_id", {
    type: "string",
    minLength: 1,
    maxLength: 255,
  }),
  "OpenAPI operation GET /v1/payment-events must define query param 'payment_intent_id'.",
);
ensure(
  hasQueryParameter(paymentEventsListOperation, "event_type", { type: "string" }),
  "OpenAPI operation GET /v1/payment-events must define query param 'event_type'.",
);
ensure(
  hasQueryParameter(paymentEventsListOperation, "occurred_from", { type: "string", format: "date-time" }),
  "OpenAPI operation GET /v1/payment-events must define query param 'occurred_from'.",
);
ensure(
  hasQueryParameter(paymentEventsListOperation, "occurred_to", { type: "string", format: "date-time" }),
  "OpenAPI operation GET /v1/payment-events must define query param 'occurred_to'.",
);
ensure(
  Boolean(paymentEventsListOperation?.responses?.["422"]),
  "OpenAPI operation GET /v1/payment-events must define 422 response.",
);
const deadLetterListOperation = openApi.paths?.["/v1/webhook-dead-letters"]?.get;
ensure(Boolean(deadLetterListOperation), "OpenAPI operation GET /v1/webhook-dead-letters missing.");
ensure(
  hasQueryParameter(deadLetterListOperation, "status", { type: "string" }),
  "OpenAPI operation GET /v1/webhook-dead-letters must define query param 'status'.",
);
ensure(
  hasQueryParameter(deadLetterListOperation, "event_type", { type: "string" }),
  "OpenAPI operation GET /v1/webhook-dead-letters must define query param 'event_type'.",
);
ensure(
  hasQueryParameter(deadLetterListOperation, "endpoint_id", {
    type: "string",
    minLength: 1,
    maxLength: 255,
  }),
  "OpenAPI operation GET /v1/webhook-dead-letters must define query param 'endpoint_id'.",
);

const rotateSecretOperation = openApi.paths?.["/v1/webhook-endpoints/{id}/rotate-secret"]?.post;
ensure(Boolean(rotateSecretOperation), "OpenAPI operation POST /v1/webhook-endpoints/{id}/rotate-secret missing.");
ensure(
  Array.isArray(rotateSecretOperation?.parameters) &&
    rotateSecretOperation.parameters.some(
      (item) => item?.in === "path" && item?.name === "id" && item?.required === true,
    ),
  "OpenAPI rotate-secret operation must require path parameter 'id'.",
);
ensure(
  rotateSecretOperation?.requestBody?.content?.["application/json"]?.schema?.$ref ===
    "#/components/schemas/RotateWebhookSecretRequest",
  "OpenAPI rotate-secret request body must reference RotateWebhookSecretRequest.",
);
ensure(
  Boolean(rotateSecretOperation?.responses?.["200"]),
  "OpenAPI rotate-secret operation must define 200 response.",
);
ensure(
  Boolean(rotateSecretOperation?.responses?.["412"]),
  "OpenAPI rotate-secret operation must define 412 response.",
);

const updateEndpointOperation = openApi.paths?.["/v1/webhook-endpoints/{id}"]?.patch;
ensure(Boolean(updateEndpointOperation), "OpenAPI operation PATCH /v1/webhook-endpoints/{id} missing.");
ensure(
  Array.isArray(updateEndpointOperation?.parameters) &&
    updateEndpointOperation.parameters.some(
      (item) => item?.in === "path" && item?.name === "id" && item?.required === true,
    ),
  "OpenAPI webhook endpoint update operation must require path parameter 'id'.",
);
ensure(
  updateEndpointOperation?.requestBody?.content?.["application/json"]?.schema?.$ref ===
    "#/components/schemas/UpdateWebhookEndpointRequest",
  "OpenAPI webhook endpoint update request body must reference UpdateWebhookEndpointRequest.",
);
ensure(
  Boolean(updateEndpointOperation?.responses?.["200"]),
  "OpenAPI webhook endpoint update operation must define 200 response.",
);
ensure(
  Boolean(updateEndpointOperation?.responses?.["422"]),
  "OpenAPI webhook endpoint update operation must define 422 response.",
);
ensure(
  Boolean(updateEndpointOperation?.responses?.["412"]),
  "OpenAPI webhook endpoint update operation must define 412 response.",
);
const replayDeadLetterOperation = openApi.paths?.["/v1/webhook-dead-letters/{id}/replay"]?.post;
ensure(
  Boolean(replayDeadLetterOperation),
  "OpenAPI operation POST /v1/webhook-dead-letters/{id}/replay missing.",
);
ensure(
  Array.isArray(replayDeadLetterOperation?.parameters) &&
    replayDeadLetterOperation.parameters.some(
      (item) => item?.in === "path" && item?.name === "id" && item?.required === true,
    ),
  "OpenAPI dead-letter replay operation must require path parameter 'id'.",
);
ensure(
  Boolean(replayDeadLetterOperation?.responses?.["200"]),
  "OpenAPI dead-letter replay operation must define 200 response.",
);
ensure(
  Boolean(replayDeadLetterOperation?.responses?.["404"]),
  "OpenAPI dead-letter replay operation must define 404 response.",
);
ensure(
  Boolean(replayDeadLetterOperation?.responses?.["409"]),
  "OpenAPI dead-letter replay operation must define 409 response.",
);
const replayDeadLettersBatchOperation = openApi.paths?.["/v1/webhook-dead-letters/replay-batch"]?.post;
ensure(
  Boolean(replayDeadLettersBatchOperation),
  "OpenAPI operation POST /v1/webhook-dead-letters/replay-batch missing.",
);
ensure(
  replayDeadLettersBatchOperation?.requestBody?.content?.["application/json"]?.schema?.$ref ===
    "#/components/schemas/ReplayDeadLettersBatchRequest",
  "OpenAPI dead-letter replay-batch request body must reference ReplayDeadLettersBatchRequest.",
);
ensure(
  Boolean(replayDeadLettersBatchOperation?.responses?.["200"]),
  "OpenAPI dead-letter replay-batch operation must define 200 response.",
);
ensure(
  Boolean(replayDeadLettersBatchOperation?.responses?.["422"]),
  "OpenAPI dead-letter replay-batch operation must define 422 response.",
);
const updateSchema = openApi.components?.schemas?.UpdateWebhookEndpointRequest;
ensure(Boolean(updateSchema), "OpenAPI schema 'UpdateWebhookEndpointRequest' is required.");
ensure(updateSchema?.minProperties === 1, "UpdateWebhookEndpointRequest.minProperties must be 1.");

const getEndpointOperation = openApi.paths?.["/v1/webhook-endpoints/{id}"]?.get;
ensure(Boolean(getEndpointOperation), "OpenAPI operation GET /v1/webhook-endpoints/{id} missing.");
ensure(
  Boolean(getEndpointOperation?.responses?.["200"]),
  "OpenAPI webhook endpoint get operation must define 200 response.",
);
const getDeadLetterOperation = openApi.paths?.["/v1/webhook-dead-letters/{id}"]?.get;
ensure(Boolean(getDeadLetterOperation), "OpenAPI operation GET /v1/webhook-dead-letters/{id} missing.");
ensure(
  Array.isArray(getDeadLetterOperation?.parameters) &&
    getDeadLetterOperation.parameters.some(
      (item) => item?.in === "path" && item?.name === "id" && item?.required === true,
    ),
  "OpenAPI dead-letter get operation must require path parameter 'id'.",
);
ensure(
  Boolean(getDeadLetterOperation?.responses?.["200"]),
  "OpenAPI dead-letter get operation must define 200 response.",
);

for (const [pathKey, method] of [
  ["/v1/webhook-endpoints", "post"],
  ["/v1/webhook-endpoints/{id}", "get"],
  ["/v1/webhook-endpoints/{id}", "patch"],
  ["/v1/webhook-endpoints/{id}/rotate-secret", "post"],
]) {
  const operation = openApi.paths?.[pathKey]?.[method];
  const successStatus = method === "post" && pathKey === "/v1/webhook-endpoints" ? "201" : "200";
  ensure(
    operation?.responses?.[successStatus]?.headers?.ETag?.$ref === "#/components/headers/EntityTag",
    `OpenAPI operation ${method.toUpperCase()} ${pathKey} must return ETag header.`,
  );
}

const ifMatchSchemaAssertions = { type: "string", minLength: 1 };

function hasHeaderParameter(operation, name, assertions) {
  const parameters = operation?.parameters ?? [];
  return parameters.some((item) => {
    if (item?.in !== "header" || item?.name !== name) {
      return false;
    }
    for (const [key, expected] of Object.entries(assertions)) {
      if (item?.schema?.[key] !== expected) {
        return false;
      }
    }
    return true;
  });
}

ensure(
  hasHeaderParameter(updateEndpointOperation, "If-Match", ifMatchSchemaAssertions),
  "OpenAPI webhook endpoint update operation must define If-Match header.",
);
ensure(
  hasHeaderParameter(rotateSecretOperation, "If-Match", ifMatchSchemaAssertions),
  "OpenAPI rotate-secret operation must define If-Match header.",
);

ensure(Boolean(openApi.components?.headers?.EntityTag), "OpenAPI header 'EntityTag' is required.");
ensure(
  Boolean(openApi.components?.headers?.IdempotencyReplayed),
  "OpenAPI header 'IdempotencyReplayed' is required.",
);
ensure(
  Boolean(openApi.components?.headers?.IdempotencyKeyEcho),
  "OpenAPI header 'IdempotencyKeyEcho' is required.",
);

const cursorPagination = openApi.components?.schemas?.CursorPagination;
ensure(Boolean(cursorPagination), "OpenAPI schema 'CursorPagination' is required.");
ensure(cursorPagination?.properties?.limit?.type === "integer", "CursorPagination.limit must be integer.");
ensure(cursorPagination?.properties?.has_more?.type === "boolean", "CursorPagination.has_more must be boolean.");
ensure(Array.isArray(cursorPagination?.required), "CursorPagination.required must be an array.");
ensure(
  ["limit", "has_more", "next_cursor"].every((key) => cursorPagination.required.includes(key)),
  "CursorPagination.required must include limit, has_more, and next_cursor.",
);

for (const schemaName of [
  "ListPaymentIntentsResponse",
  "ListRefundsResponse",
  "ListChargebacksResponse",
  "ListPaymentEventsResponse",
  "ListWebhookEndpointsResponse",
  "ListWebhookDeliveriesResponse",
  "ListWebhookDeadLettersResponse",
]) {
  const responseSchema = openApi.components?.schemas?.[schemaName];
  ensure(Boolean(responseSchema), `OpenAPI schema '${schemaName}' missing.`);
  ensure(
    responseSchema?.properties?.pagination?.$ref === "#/components/schemas/CursorPagination",
    `${schemaName}.pagination must reference CursorPagination.`,
  );
}
const webhookDeadLetterSchema = openApi.components?.schemas?.WebhookDeadLetter;
ensure(Boolean(webhookDeadLetterSchema), "OpenAPI schema 'WebhookDeadLetter' is required.");
ensure(
  Array.isArray(webhookDeadLetterSchema?.required) &&
    ["id", "endpoint_id", "event_id", "event_type", "attempts", "status", "replay_count", "failure_reason"].every(
      (field) => webhookDeadLetterSchema.required.includes(field),
    ),
  "WebhookDeadLetter.required must include core dead-letter fields.",
);

const paymentIntentSchema = openApi.components?.schemas?.PaymentIntent;
ensure(Boolean(paymentIntentSchema), "OpenAPI schema 'PaymentIntent' is required.");
ensure(Array.isArray(paymentIntentSchema?.required), "OpenAPI schema 'PaymentIntent.required' must be an array.");
for (const requiredField of [
  "customer_id",
  "payment_method_type",
  "authorized_amount",
  "captured_amount",
  "refunded_amount",
  "amount_refundable",
  "provider",
  "provider_reference",
]) {
  ensure(
    paymentIntentSchema.required.includes(requiredField),
    `OpenAPI schema 'PaymentIntent.required' must include '${requiredField}'.`,
  );
}
ensure(
  paymentIntentSchema?.properties?.customer_id?.type === "string",
  "OpenAPI schema 'PaymentIntent.customer_id' must be string.",
);
ensure(
  paymentIntentSchema?.properties?.payment_method_type?.type === "string",
  "OpenAPI schema 'PaymentIntent.payment_method_type' must be string.",
);
for (const field of ["authorized_amount", "captured_amount", "refunded_amount", "amount_refundable"]) {
  ensure(
    paymentIntentSchema?.properties?.[field]?.type === "integer",
    `OpenAPI schema 'PaymentIntent.${field}' must be integer.`,
  );
}
ensure(
  paymentIntentSchema?.properties?.provider?.type === "string" &&
    paymentIntentSchema?.properties?.provider?.nullable === true,
  "OpenAPI schema 'PaymentIntent.provider' must be nullable string.",
);
ensure(
  paymentIntentSchema?.properties?.provider_reference?.type === "string" &&
    paymentIntentSchema?.properties?.provider_reference?.nullable === true,
  "OpenAPI schema 'PaymentIntent.provider_reference' must be nullable string.",
);
const paymentEventSchema = openApi.components?.schemas?.PaymentEvent;
ensure(Boolean(paymentEventSchema), "OpenAPI schema 'PaymentEvent' is required.");
ensure(
  Array.isArray(paymentEventSchema?.required) &&
    ["id", "api_version", "source", "event_version", "type", "occurred_at", "data"].every((field) =>
      paymentEventSchema.required.includes(field),
    ),
  "OpenAPI schema 'PaymentEvent.required' must include event envelope fields.",
);
for (const schemaName of [
  "CreateChargebackRequest",
  "ResolveChargebackRequest",
  "Chargeback",
  "ListChargebacksResponse",
  "ReconciliationSummaryResponse",
  "ReplayDeadLettersBatchRequest",
  "ReplayDeadLettersBatchItem",
  "ReplayDeadLettersBatchSummary",
  "ReplayDeadLettersBatchResponse",
]) {
  ensure(Boolean(openApi.components?.schemas?.[schemaName]), `OpenAPI schema '${schemaName}' missing.`);
}

const asyncApiRaw = await readFile(asyncApiPath, "utf8");
const asyncApi = yaml.load(asyncApiRaw);
ensure(asyncApi && typeof asyncApi === "object", "AsyncAPI file is not a valid YAML object.");
ensure(String(asyncApi.asyncapi ?? "").startsWith("3."), "AsyncAPI version must be 3.x.");
ensure(asyncApi.channels && typeof asyncApi.channels === "object", "AsyncAPI channels section missing.");
const paymentEventPayload = asyncApi.components?.messages?.PaymentEvent?.payload;
const eventEnum = paymentEventPayload?.properties?.type?.enum ?? [];
const hasApiVersionField = Boolean(paymentEventPayload?.properties?.api_version);
const hasSourceField = Boolean(paymentEventPayload?.properties?.source);
const hasEventVersionField = Boolean(paymentEventPayload?.properties?.event_version);
const payloadRequired = paymentEventPayload?.required ?? [];
const requiredEvents = [
  "payment_intent.created",
  "payment_intent.processing",
  "payment_intent.requires_action",
  "payment_intent.succeeded",
  "payment_intent.failed",
  "payment_intent.canceled",
  "refund.succeeded",
  "refund.failed",
  "chargeback.opened",
  "chargeback.won",
  "chargeback.lost",
];
ensure(
  Array.isArray(eventEnum) && requiredEvents.every((eventType) => eventEnum.includes(eventType)),
  "AsyncAPI event enum is missing one or more required event types.",
);
ensure(hasApiVersionField, "AsyncAPI PaymentEvent payload must include 'api_version'.");
ensure(hasSourceField, "AsyncAPI PaymentEvent payload must include 'source'.");
ensure(hasEventVersionField, "AsyncAPI PaymentEvent payload must include 'event_version'.");
ensure(
  Array.isArray(payloadRequired) &&
    ["id", "api_version", "source", "event_version", "type", "occurred_at", "data"].every((field) =>
      payloadRequired.includes(field),
    ),
  "AsyncAPI PaymentEvent required fields are incomplete.",
);

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);

for (const schemaPath of schemaPaths) {
  const schemaRaw = await readFile(schemaPath, "utf8");
  const schema = JSON.parse(schemaRaw);
  try {
    ajv.compile(schema);
  } catch (error) {
    fail(`Schema validation failed for '${path.basename(schemaPath)}': ${String(error)}`);
  }
}

console.log("contracts:check OK");
