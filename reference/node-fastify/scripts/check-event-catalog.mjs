import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "../../..");

function fail(message) {
  console.error(`events:check failed: ${message}`);
  process.exit(1);
}

function toSet(values, sourceName) {
  if (!Array.isArray(values)) {
    fail(`'${sourceName}' did not return an array of events.`);
  }
  return new Set(values.map((item) => String(item)));
}

function setDiff(left, right) {
  const missing = [];
  for (const item of left) {
    if (!right.has(item)) {
      missing.push(item);
    }
  }
  return missing;
}

function assertSameSet(baseName, baseSet, compareName, compareSet) {
  const missingInCompare = setDiff(baseSet, compareSet);
  const extraInCompare = setDiff(compareSet, baseSet);
  if (missingInCompare.length === 0 && extraInCompare.length === 0) {
    return;
  }
  fail(
    `${compareName} differs from ${baseName}. missing=[${missingInCompare.join(", ")}], extra=[${extraInCompare.join(", ")}]`,
  );
}

function extractTypeScriptPaymentEvents(content) {
  const blockMatch = content.match(/export interface PaymentEvent[\s\S]*?type:\s*([\s\S]*?)\s*occurred_at:/m);
  if (!blockMatch || !blockMatch[1]) {
    fail("Could not locate PaymentEvent type union in src/domain/types.ts");
  }
  const literalMatches = [...blockMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  if (literalMatches.length === 0) {
    fail("No string literal events found in PaymentEvent type union.");
  }
  return literalMatches;
}

function assertTypeScriptEventField(content, fieldName) {
  const blockMatch = content.match(/export interface PaymentEvent[\s\S]*?{([\s\S]*?)}/m);
  if (!blockMatch || !blockMatch[1]) {
    fail("Could not locate PaymentEvent interface block in src/domain/types.ts");
  }
  if (!new RegExp(`\\b${fieldName}\\s*:`).test(blockMatch[1])) {
    fail(`TypeScript PaymentEvent interface missing field '${fieldName}'.`);
  }
}

const asyncApiPath = path.join(root, "contracts/asyncapi/payment-events.v1.yaml");
const openApiPath = path.join(root, "contracts/openapi/payment-module.v1.yaml");
const webhookSchemaPath = path.join(root, "schemas/webhook-event.v1.json");
const typesPath = path.join(root, "reference/node-fastify/src/domain/types.ts");

const asyncApi = yaml.load(await readFile(asyncApiPath, "utf8"));
const openApi = yaml.load(await readFile(openApiPath, "utf8"));
const webhookSchema = JSON.parse(await readFile(webhookSchemaPath, "utf8"));
const typesContent = await readFile(typesPath, "utf8");

const asyncApiEvents =
  asyncApi?.components?.messages?.PaymentEvent?.payload?.properties?.type?.enum;
const openApiWebhookEvents =
  openApi?.components?.schemas?.CreateWebhookEndpointRequest?.properties?.events?.items?.enum;
const webhookSchemaEvents = webhookSchema?.properties?.type?.enum;
const typeScriptEvents = extractTypeScriptPaymentEvents(typesContent);

const base = toSet(asyncApiEvents, "AsyncAPI");
const openApiSet = toSet(openApiWebhookEvents, "OpenAPI webhook endpoint enum");
const schemaSet = toSet(webhookSchemaEvents, "webhook-event schema");
const typesSet = toSet(typeScriptEvents, "TypeScript PaymentEvent type");

assertSameSet("AsyncAPI", base, "OpenAPI webhook endpoint enum", openApiSet);
assertSameSet("AsyncAPI", base, "webhook-event schema", schemaSet);
assertSameSet("AsyncAPI", base, "TypeScript PaymentEvent type", typesSet);

for (const fieldName of ["api_version", "source", "event_version"]) {
  if (!asyncApi?.components?.messages?.PaymentEvent?.payload?.properties?.[fieldName]) {
    fail(`AsyncAPI PaymentEvent payload missing field '${fieldName}'.`);
  }
  if (!webhookSchema?.properties?.[fieldName]) {
    fail(`webhook-event schema missing field '${fieldName}'.`);
  }
  assertTypeScriptEventField(typesContent, fieldName);
}

console.log("events:check OK");
