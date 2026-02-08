import type { PaymentEvent } from "../domain/types.js";

export interface PaymentEventListInput {
  limit: number;
  cursor?: string;
  paymentIntentId?: string;
  eventType?: PaymentEvent["type"];
  occurredFrom?: string;
  occurredTo?: string;
}

export interface PaymentEventListResult {
  data: PaymentEvent[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface EventBusPort {
  publish(event: PaymentEvent): Promise<void>;
  listPublishedEvents(input: PaymentEventListInput): Promise<PaymentEventListResult>;
  subscribe(handler: (event: PaymentEvent) => Promise<void>): void;
  close?(): Promise<void>;
}
