import type { PaymentEvent } from "../../domain/types.js";
import type { EventBusPort, PaymentEventListInput, PaymentEventListResult } from "../../ports/event-bus.js";
import { AppError } from "../../infra/app-error.js";

export class InMemoryEventBus implements EventBusPort {
  private readonly outbox: PaymentEvent[] = [];
  private readonly subscribers: Array<(event: PaymentEvent) => Promise<void>> = [];

  async publish(event: PaymentEvent): Promise<void> {
    this.outbox.push(event);
    for (const subscriber of this.subscribers) {
      await subscriber(event);
    }
  }

  getPublishedEvents(): PaymentEvent[] {
    return [...this.outbox];
  }

  async listPublishedEvents(input: PaymentEventListInput): Promise<PaymentEventListResult> {
    const items = [...this.outbox]
      .filter((event) => {
        if (input.paymentIntentId) {
          const paymentIntentId = event.data?.payment_intent_id;
          if (typeof paymentIntentId !== "string" || paymentIntentId !== input.paymentIntentId) {
            return false;
          }
        }
        if (input.eventType && event.type !== input.eventType) {
          return false;
        }
        if (input.occurredFrom) {
          const occurredFromMs = Date.parse(input.occurredFrom);
          const eventOccurredAtMs = Date.parse(event.occurred_at);
          if (Number.isFinite(occurredFromMs) && Number.isFinite(eventOccurredAtMs) && eventOccurredAtMs < occurredFromMs) {
            return false;
          }
        }
        if (input.occurredTo) {
          const occurredToMs = Date.parse(input.occurredTo);
          const eventOccurredAtMs = Date.parse(event.occurred_at);
          if (Number.isFinite(occurredToMs) && Number.isFinite(eventOccurredAtMs) && eventOccurredAtMs > occurredToMs) {
            return false;
          }
        }
        return true;
      })
      .sort((a, b) => {
        const byOccurredAt = b.occurred_at.localeCompare(a.occurred_at);
        if (byOccurredAt !== 0) {
          return byOccurredAt;
        }
        return b.id.localeCompare(a.id);
      });

    const limit = Math.max(1, input.limit);
    let startIndex = 0;
    if (input.cursor) {
      const cursorIndex = items.findIndex((item) => item.id === input.cursor);
      if (cursorIndex < 0) {
        throw new AppError(422, "invalid_cursor", "cursor not found for current collection.");
      }
      startIndex = cursorIndex + 1;
    }

    const page = items.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + page.length < items.length;
    const lastItem = page.at(-1);
    const nextCursor = hasMore && lastItem ? lastItem.id : undefined;

    return {
      data: page,
      hasMore,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  subscribe(handler: (event: PaymentEvent) => Promise<void>): void {
    this.subscribers.push(handler);
  }
}
