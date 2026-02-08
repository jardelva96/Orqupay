export type PaymentMethodType = "card" | "pix" | "boleto" | "wallet" | "bank_transfer";

export type CaptureMethod = "automatic" | "manual";

export type PaymentStatus =
  | "requires_confirmation"
  | "processing"
  | "requires_action"
  | "succeeded"
  | "failed"
  | "canceled";

export type RefundStatus = "pending" | "succeeded" | "failed";
export type ChargebackStatus = "open" | "under_review" | "won" | "lost";
export type LedgerEntryType = "authorization" | "capture" | "refund" | "chargeback";
export type LedgerEntryDirection = "debit" | "credit";

export interface PaymentIntentRecord {
  id: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  capture_method: CaptureMethod;
  customer_id: string;
  payment_method_type: PaymentMethodType;
  payment_method_token: string;
  authorized_amount: number;
  captured_amount: number;
  refunded_amount: number;
  provider: string | null;
  provider_reference: string | null;
  created_at: string;
  updated_at: string;
}

export interface RefundRecord {
  id: string;
  payment_intent_id: string;
  amount: number;
  status: RefundStatus;
  reason?: "requested_by_customer" | "duplicate" | "fraud" | "other";
  created_at: string;
}

export interface ChargebackRecord {
  id: string;
  payment_intent_id: string;
  amount: number;
  reason: "fraud" | "chargeback_dispute" | "service_not_received" | "other";
  status: ChargebackStatus;
  evidence_url?: string;
  created_at: string;
  updated_at: string;
}

export interface LedgerEntryRecord {
  id: string;
  payment_intent_id: string;
  refund_id: string | null;
  entry_type: LedgerEntryType;
  direction: LedgerEntryDirection;
  amount: number;
  currency: string;
  provider: string | null;
  provider_reference: string | null;
  created_at: string;
}

export interface PaymentIntentResponse {
  id: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  capture_method: CaptureMethod;
  customer_id: string;
  payment_method_type: PaymentMethodType;
  authorized_amount: number;
  captured_amount: number;
  refunded_amount: number;
  amount_refundable: number;
  provider: string | null;
  provider_reference: string | null;
  created_at: string;
  updated_at: string;
}

export interface RefundResponse {
  id: string;
  payment_intent_id: string;
  amount: number;
  status: RefundStatus;
  created_at: string;
}

export interface ChargebackResponse {
  id: string;
  payment_intent_id: string;
  amount: number;
  reason: "fraud" | "chargeback_dispute" | "service_not_received" | "other";
  status: ChargebackStatus;
  evidence_url?: string;
  created_at: string;
  updated_at: string;
}

export interface LedgerEntryResponse {
  id: string;
  payment_intent_id: string;
  refund_id: string | null;
  entry_type: LedgerEntryType;
  direction: LedgerEntryDirection;
  amount: number;
  currency: string;
  provider: string | null;
  provider_reference: string | null;
  created_at: string;
}

export interface CreatePaymentIntentInput {
  amount: number;
  currency: string;
  customer: { id: string };
  payment_method: {
    type: PaymentMethodType;
    token: string;
  };
  capture_method: CaptureMethod;
}

export interface CreateRefundInput {
  payment_intent_id: string;
  amount: number;
  reason?: "requested_by_customer" | "duplicate" | "fraud" | "other";
}

export interface CreateChargebackInput {
  payment_intent_id: string;
  amount: number;
  reason: "fraud" | "chargeback_dispute" | "service_not_received" | "other";
  evidence_url?: string;
}

export interface PaymentEvent {
  id: string;
  api_version: string;
  source: string;
  event_version: string;
  type:
    | "payment_intent.created"
    | "payment_intent.processing"
    | "payment_intent.requires_action"
    | "payment_intent.succeeded"
    | "payment_intent.failed"
    | "payment_intent.canceled"
    | "refund.succeeded"
    | "refund.failed"
    | "chargeback.opened"
    | "chargeback.won"
    | "chargeback.lost";
  occurred_at: string;
  data: Record<string, unknown>;
}

export interface WebhookEndpointRecord {
  id: string;
  url: string;
  events: PaymentEvent["type"][];
  secret: string;
  enabled: boolean;
  created_at: string;
}

export type WebhookDeliveryStatus = "succeeded" | "failed";

export interface WebhookDeliveryRecord {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: PaymentEvent["type"];
  attempt: number;
  status: WebhookDeliveryStatus;
  response_status?: number;
  error_code?: string;
  created_at: string;
  delivered_at?: string;
}

export type WebhookDeadLetterFailureReason = "permanent_failure" | "max_attempts_exhausted";
export type WebhookDeadLetterStatus = "pending" | "replayed";

export interface WebhookDeadLetterRecord {
  id: string;
  endpoint_id: string;
  endpoint_url: string;
  event_id: string;
  event_type: PaymentEvent["type"];
  attempts: number;
  status: WebhookDeadLetterStatus;
  replay_count: number;
  failure_reason: WebhookDeadLetterFailureReason;
  response_status?: number;
  error_code?: string;
  failed_at: string;
  last_replayed_at?: string;
}

export interface StoredWebhookDeadLetterRecord extends WebhookDeadLetterRecord {
  event: PaymentEvent;
}
