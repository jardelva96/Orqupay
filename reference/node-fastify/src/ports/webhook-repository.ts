import type {
  PaymentEvent,
  StoredWebhookDeadLetterRecord,
  WebhookDeadLetterRecord,
  WebhookDeliveryRecord,
  WebhookEndpointRecord,
} from "../domain/types.js";

export interface CreateWebhookEndpointInput {
  url: string;
  events: PaymentEvent["type"][];
  secret: string;
  enabled: boolean;
  createdAt: string;
}

export interface UpdateWebhookEndpointInput {
  url?: string;
  events?: PaymentEvent["type"][];
  enabled?: boolean;
}

export interface CursorPaginationInput {
  limit: number;
  cursor?: string;
}

export interface CursorPaginationResult<T> {
  data: T[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface WebhookDeadLetterListInput extends CursorPaginationInput {
  status?: WebhookDeadLetterRecord["status"];
  eventType?: PaymentEvent["type"];
  endpointId?: string;
}

export interface WebhookRepositoryPort {
  createEndpoint(input: CreateWebhookEndpointInput): Promise<WebhookEndpointRecord>;
  getEndpointById(endpointId: string): Promise<WebhookEndpointRecord>;
  updateEndpoint(endpointId: string, input: UpdateWebhookEndpointInput): Promise<WebhookEndpointRecord>;
  rotateEndpointSecret(endpointId: string, secret: string): Promise<WebhookEndpointRecord>;
  listEndpoints(input: CursorPaginationInput): Promise<CursorPaginationResult<WebhookEndpointRecord>>;
  listEnabledEndpointsByEvent(eventType: PaymentEvent["type"]): Promise<WebhookEndpointRecord[]>;
  saveDelivery(delivery: WebhookDeliveryRecord): Promise<void>;
  listDeliveries(input: CursorPaginationInput): Promise<CursorPaginationResult<WebhookDeliveryRecord>>;
  saveDeadLetter(deadLetter: StoredWebhookDeadLetterRecord): Promise<void>;
  listDeadLetters(input: WebhookDeadLetterListInput): Promise<CursorPaginationResult<WebhookDeadLetterRecord>>;
  getDeadLetterById(deadLetterId: string): Promise<StoredWebhookDeadLetterRecord>;
  updateDeadLetter(deadLetter: StoredWebhookDeadLetterRecord): Promise<void>;
}
