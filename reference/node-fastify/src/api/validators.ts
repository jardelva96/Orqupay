import type {
  ChargebackStatus,
  CreateChargebackInput,
  CreatePaymentIntentInput,
  CreateRefundInput,
  LedgerEntryDirection,
  LedgerEntryType,
  PaymentEvent,
  PaymentMethodType,
  PaymentStatus,
  RefundStatus,
  WebhookDeadLetterStatus,
} from "../domain/types.js";
import { AppError } from "../infra/app-error.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const paymentMethodTypes: Set<PaymentMethodType> = new Set(["card", "pix", "boleto", "wallet", "bank_transfer"]);

export function assertCreatePaymentIntentInput(payload: unknown): asserts payload is CreatePaymentIntentInput {
  if (!isObject(payload)) {
    throw new AppError(400, "invalid_request_body", "Request body must be an object.");
  }

  const { amount, currency, customer, payment_method, capture_method } = payload;

  const captureMethods = new Set(["automatic", "manual"]);

  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
    throw new AppError(422, "invalid_amount", "Amount must be an integer greater than zero.");
  }
  if (!isString(currency) || currency.length !== 3) {
    throw new AppError(422, "invalid_currency", "Currency must be a 3-letter ISO code.");
  }
  if (!isObject(customer) || !isString(customer.id)) {
    throw new AppError(422, "invalid_customer", "Customer id is required.");
  }
  if (
    !isObject(payment_method) ||
    !isString(payment_method.token) ||
    !isString(payment_method.type) ||
    !paymentMethodTypes.has(payment_method.type as PaymentMethodType)
  ) {
    throw new AppError(422, "invalid_payment_method", "Invalid payment method payload.");
  }
  if (!isString(capture_method) || !captureMethods.has(capture_method)) {
    throw new AppError(422, "invalid_capture_method", "capture_method must be automatic or manual.");
  }
}

export function assertCaptureInput(payload: unknown): asserts payload is { amount: number } {
  if (!isObject(payload) || typeof payload.amount !== "number" || payload.amount <= 0) {
    throw new AppError(422, "invalid_amount", "Capture amount must be greater than zero.");
  }
}

export function assertCreateRefundInput(payload: unknown): asserts payload is CreateRefundInput {
  if (!isObject(payload)) {
    throw new AppError(400, "invalid_request_body", "Request body must be an object.");
  }

  if (!isString(payload.payment_intent_id)) {
    throw new AppError(422, "invalid_payment_intent_id", "payment_intent_id is required.");
  }
  if (typeof payload.amount !== "number" || !Number.isInteger(payload.amount) || payload.amount <= 0) {
    throw new AppError(422, "invalid_amount", "Refund amount must be an integer greater than zero.");
  }

  if (payload.reason !== undefined) {
    const reasons = new Set(["requested_by_customer", "duplicate", "fraud", "other"]);
    if (!isString(payload.reason) || !reasons.has(payload.reason)) {
      throw new AppError(422, "invalid_refund_reason", "Invalid refund reason.");
    }
  }
}

export function assertCreateChargebackInput(payload: unknown): asserts payload is CreateChargebackInput {
  if (!isObject(payload)) {
    throw new AppError(400, "invalid_request_body", "Request body must be an object.");
  }

  if (!isString(payload.payment_intent_id)) {
    throw new AppError(422, "invalid_payment_intent_id", "payment_intent_id is required.");
  }
  if (typeof payload.amount !== "number" || !Number.isInteger(payload.amount) || payload.amount <= 0) {
    throw new AppError(422, "invalid_amount", "Chargeback amount must be an integer greater than zero.");
  }
  const reasons = new Set(["fraud", "chargeback_dispute", "service_not_received", "other"]);
  if (!isString(payload.reason) || !reasons.has(payload.reason)) {
    throw new AppError(422, "invalid_chargeback_reason", "Invalid chargeback reason.");
  }
  if (payload.evidence_url !== undefined && !isString(payload.evidence_url)) {
    throw new AppError(422, "invalid_evidence_url", "evidence_url must be a non-empty string.");
  }
}

export function assertResolveChargebackInput(
  payload: unknown,
): asserts payload is { status: ChargebackStatus } {
  if (!isObject(payload)) {
    throw new AppError(400, "invalid_request_body", "Request body must be an object.");
  }
  const allowed = new Set(["under_review", "won", "lost"]);
  if (!isString(payload.status) || !allowed.has(payload.status)) {
    throw new AppError(
      422,
      "invalid_chargeback_status",
      "status must be one of: under_review, won, lost.",
    );
  }
}

interface CreateWebhookEndpointInput {
  url: string;
  events?: PaymentEvent["type"][];
  secret?: string;
  enabled?: boolean;
}

interface RotateWebhookSecretInput {
  secret?: string;
}

interface UpdateWebhookEndpointInput {
  url?: string;
  events?: PaymentEvent["type"][];
  enabled?: boolean;
}

interface ReplayDeadLettersBatchInput {
  limit?: number;
  status?: WebhookDeadLetterStatus;
  event_type?: PaymentEvent["type"];
  endpoint_id?: string;
}

const webhookEventTypes: Set<PaymentEvent["type"]> = new Set([
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
]);
const webhookDeadLetterStatuses: Set<WebhookDeadLetterStatus> = new Set(["pending", "replayed"]);
const paymentStatuses: Set<PaymentStatus> = new Set([
  "requires_confirmation",
  "processing",
  "requires_action",
  "succeeded",
  "failed",
  "canceled",
]);
const refundStatuses: Set<RefundStatus> = new Set(["pending", "succeeded", "failed"]);
const chargebackStatuses: Set<ChargebackStatus> = new Set(["open", "under_review", "won", "lost"]);
const ledgerEntryTypes: Set<LedgerEntryType> = new Set(["authorization", "capture", "refund", "chargeback"]);
const ledgerEntryDirections: Set<LedgerEntryDirection> = new Set(["debit", "credit"]);

export function assertCreateWebhookEndpointInput(
  payload: unknown,
): asserts payload is CreateWebhookEndpointInput {
  if (!isObject(payload)) {
    throw new AppError(400, "invalid_request_body", "Request body must be an object.");
  }

  if (!isString(payload.url)) {
    throw new AppError(422, "invalid_webhook_url", "Webhook url is required.");
  }

  if (payload.events !== undefined) {
    if (!Array.isArray(payload.events)) {
      throw new AppError(422, "invalid_webhook_events", "Webhook events must be an array.");
    }

    for (const eventType of payload.events) {
      if (typeof eventType !== "string" || !webhookEventTypes.has(eventType as PaymentEvent["type"])) {
        throw new AppError(422, "invalid_webhook_events", `Unsupported webhook event '${String(eventType)}'.`);
      }
    }
  }

  if (payload.secret !== undefined && !isString(payload.secret)) {
    throw new AppError(422, "invalid_webhook_secret", "Webhook secret must be a non-empty string.");
  }

  if (payload.enabled !== undefined && typeof payload.enabled !== "boolean") {
    throw new AppError(422, "invalid_webhook_enabled", "Webhook enabled must be boolean.");
  }
}

export function assertRotateWebhookSecretInput(
  payload: unknown,
): asserts payload is RotateWebhookSecretInput | undefined {
  if (payload === undefined) {
    return;
  }
  if (!isObject(payload)) {
    throw new AppError(400, "invalid_request_body", "Request body must be an object.");
  }
  if (payload.secret !== undefined && !isString(payload.secret)) {
    throw new AppError(422, "invalid_webhook_secret", "Webhook secret must be a non-empty string.");
  }
}

export function assertUpdateWebhookEndpointInput(
  payload: unknown,
): asserts payload is UpdateWebhookEndpointInput {
  if (!isObject(payload)) {
    throw new AppError(400, "invalid_request_body", "Request body must be an object.");
  }

  const hasUrl = payload.url !== undefined;
  const hasEvents = payload.events !== undefined;
  const hasEnabled = payload.enabled !== undefined;
  if (!hasUrl && !hasEvents && !hasEnabled) {
    throw new AppError(
      422,
      "invalid_webhook_update",
      "At least one of url, events, or enabled must be provided.",
    );
  }

  if (hasUrl && !isString(payload.url)) {
    throw new AppError(422, "invalid_webhook_url", "Webhook url must be a non-empty string.");
  }

  if (hasEvents) {
    if (!Array.isArray(payload.events)) {
      throw new AppError(422, "invalid_webhook_events", "Webhook events must be an array.");
    }
    for (const eventType of payload.events) {
      if (typeof eventType !== "string" || !webhookEventTypes.has(eventType as PaymentEvent["type"])) {
        throw new AppError(422, "invalid_webhook_events", `Unsupported webhook event '${String(eventType)}'.`);
      }
    }
  }

  if (hasEnabled && typeof payload.enabled !== "boolean") {
    throw new AppError(422, "invalid_webhook_enabled", "Webhook enabled must be boolean.");
  }
}

export function assertReplayDeadLettersBatchInput(
  payload: unknown,
): asserts payload is ReplayDeadLettersBatchInput | undefined {
  if (payload === undefined) {
    return;
  }
  if (!isObject(payload)) {
    throw new AppError(400, "invalid_request_body", "Request body must be an object.");
  }

  if (payload.limit !== undefined) {
    if (typeof payload.limit !== "number" || !Number.isInteger(payload.limit) || payload.limit <= 0) {
      throw new AppError(
        422,
        "invalid_replay_batch",
        "limit must be a positive integer when provided.",
      );
    }
  }

  if (payload.status !== undefined) {
    if (typeof payload.status !== "string" || !webhookDeadLetterStatuses.has(payload.status as WebhookDeadLetterStatus)) {
      throw new AppError(422, "invalid_replay_batch", "status must be one of: pending, replayed.");
    }
  }

  if (payload.event_type !== undefined) {
    if (typeof payload.event_type !== "string" || !webhookEventTypes.has(payload.event_type as PaymentEvent["type"])) {
      throw new AppError(422, "invalid_replay_batch", "event_type is invalid.");
    }
  }

  if (payload.endpoint_id !== undefined) {
    if (!isString(payload.endpoint_id) || payload.endpoint_id.length > 255) {
      throw new AppError(
        422,
        "invalid_replay_batch",
        "endpoint_id must be a non-empty string up to 255 characters.",
      );
    }
  }
}

export function normalizeLimit(value: unknown, fallback = 50, max = 500): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AppError(422, "invalid_limit", "limit must be a positive integer.");
  }
  return Math.min(parsed, max);
}

export function normalizePositiveInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new AppError(422, `invalid_${fieldName}`, `${fieldName} must be a string.`);
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AppError(422, `invalid_${fieldName}`, `${fieldName} must be a positive integer.`);
  }
  return parsed;
}

export function normalizeCursor(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new AppError(422, "invalid_cursor", "cursor must be a string.");
  }

  const cursor = value.trim();
  if (cursor.length === 0 || cursor.length > 512) {
    throw new AppError(422, "invalid_cursor", "cursor length must be between 1 and 512 characters.");
  }
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new AppError(422, "invalid_cursor", "cursor token format is invalid.");
  }

  return cursor;
}

export function normalizeIfMatch(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new AppError(422, "invalid_if_match", "If-Match header must be a string.");
  }

  const header = value.trim();
  if (header.length === 0) {
    throw new AppError(422, "invalid_if_match", "If-Match header must not be empty.");
  }
  if (header === "*") {
    return header;
  }
  if (!/^"[^"]+"$/.test(header)) {
    throw new AppError(422, "invalid_if_match", 'If-Match must be "*" or a quoted ETag value.');
  }

  return header;
}

export function normalizeWebhookDeadLetterStatus(value: unknown): WebhookDeadLetterStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new AppError(422, "invalid_dead_letter_status", "status must be a string.");
  }

  const status = value.trim();
  if (!webhookDeadLetterStatuses.has(status as WebhookDeadLetterStatus)) {
    throw new AppError(422, "invalid_dead_letter_status", "status must be one of: pending, replayed.");
  }
  return status as WebhookDeadLetterStatus;
}

export function normalizeWebhookEventType(value: unknown): PaymentEvent["type"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new AppError(422, "invalid_webhook_event_type", "event_type must be a string.");
  }

  const eventType = value.trim();
  if (!webhookEventTypes.has(eventType as PaymentEvent["type"])) {
    throw new AppError(422, "invalid_webhook_event_type", "Unsupported webhook event type.");
  }
  return eventType as PaymentEvent["type"];
}

export function normalizePaymentStatus(value: unknown): PaymentStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new AppError(422, "invalid_payment_status", "status must be a string.");
  }

  const status = value.trim();
  if (!paymentStatuses.has(status as PaymentStatus)) {
    throw new AppError(422, "invalid_payment_status", "Unsupported payment status.");
  }
  return status as PaymentStatus;
}

export function normalizeCurrencyCode(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new AppError(422, "invalid_currency", "currency must be a string.");
  }

  const currency = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new AppError(422, "invalid_currency", "currency must be a 3-letter ISO code.");
  }
  return currency;
}

export function normalizePaymentMethodType(value: unknown): PaymentMethodType | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new AppError(422, "invalid_payment_method_type", "payment_method_type must be a string.");
  }

  const type = value.trim();
  if (!paymentMethodTypes.has(type as PaymentMethodType)) {
    throw new AppError(422, "invalid_payment_method_type", "Unsupported payment_method_type.");
  }
  return type as PaymentMethodType;
}

export function normalizeRefundStatus(value: unknown): RefundStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new AppError(422, "invalid_refund_status", "status must be a string.");
  }

  const status = value.trim();
  if (!refundStatuses.has(status as RefundStatus)) {
    throw new AppError(422, "invalid_refund_status", "Unsupported refund status.");
  }
  return status as RefundStatus;
}

export function normalizeLedgerEntryType(value: unknown): LedgerEntryType | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new AppError(422, "invalid_ledger_entry_type", "entry_type must be a string.");
  }
  const entryType = value.trim();
  if (entryType.length === 0) {
    throw new AppError(422, "invalid_ledger_entry_type", "entry_type must not be empty.");
  }
  if (!ledgerEntryTypes.has(entryType as LedgerEntryType)) {
    throw new AppError(422, "invalid_ledger_entry_type", "Unsupported ledger entry type.");
  }
  return entryType as LedgerEntryType;
}

export function normalizeLedgerDirection(value: unknown): LedgerEntryDirection | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new AppError(422, "invalid_ledger_direction", "direction must be a string.");
  }
  const direction = value.trim();
  if (direction.length === 0) {
    throw new AppError(422, "invalid_ledger_direction", "direction must not be empty.");
  }
  if (!ledgerEntryDirections.has(direction as LedgerEntryDirection)) {
    throw new AppError(422, "invalid_ledger_direction", "Unsupported ledger direction.");
  }
  return direction as LedgerEntryDirection;
}

export function normalizeChargebackStatus(value: unknown): ChargebackStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new AppError(422, "invalid_chargeback_status", "status must be a string.");
  }

  const status = value.trim();
  if (!chargebackStatuses.has(status as ChargebackStatus)) {
    throw new AppError(422, "invalid_chargeback_status", "Unsupported chargeback status.");
  }
  return status as ChargebackStatus;
}

export function normalizeIsoDateTime(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new AppError(422, `invalid_${fieldName}`, `${fieldName} must be a string.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 64) {
    throw new AppError(
      422,
      `invalid_${fieldName}`,
      `${fieldName} length must be between 1 and 64 characters.`,
    );
  }
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) {
    throw new AppError(422, `invalid_${fieldName}`, `${fieldName} must be a valid ISO-8601 date-time.`);
  }
  return new Date(timestamp).toISOString();
}

export function normalizeResourceId(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new AppError(422, `invalid_${fieldName}`, `${fieldName} must be a string.`);
  }

  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 255) {
    throw new AppError(
      422,
      `invalid_${fieldName}`,
      `${fieldName} length must be between 1 and 255 characters.`,
    );
  }
  return normalized;
}
