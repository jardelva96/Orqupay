import { randomUUID } from "node:crypto";
import type {
  StoredWebhookDeadLetterRecord,
  WebhookDeadLetterRecord,
  WebhookDeliveryRecord,
  WebhookEndpointRecord,
} from "../../domain/types.js";
import { AppError } from "../../infra/app-error.js";
import type {
  CursorPaginationInput,
  CursorPaginationResult,
  CreateWebhookEndpointInput,
  UpdateWebhookEndpointInput,
  WebhookDeadLetterListInput,
  WebhookRepositoryPort,
} from "../../ports/webhook-repository.js";

export class InMemoryWebhookRepository implements WebhookRepositoryPort {
  private readonly endpoints = new Map<string, WebhookEndpointRecord>();
  private readonly deliveries: WebhookDeliveryRecord[] = [];
  private readonly deadLetters: StoredWebhookDeadLetterRecord[] = [];

  async createEndpoint(input: CreateWebhookEndpointInput): Promise<WebhookEndpointRecord> {
    const endpoint: WebhookEndpointRecord = {
      id: `we_${randomUUID()}`,
      url: input.url,
      events: input.events,
      secret: input.secret,
      enabled: input.enabled,
      created_at: input.createdAt,
    };

    this.endpoints.set(endpoint.id, endpoint);
    return endpoint;
  }

  async getEndpointById(endpointId: string): Promise<WebhookEndpointRecord> {
    const endpoint = this.endpoints.get(endpointId);
    if (!endpoint) {
      throw new AppError(404, "resource_not_found", "Webhook endpoint not found.");
    }
    return endpoint;
  }

  async updateEndpoint(endpointId: string, input: UpdateWebhookEndpointInput): Promise<WebhookEndpointRecord> {
    const current = this.endpoints.get(endpointId);
    if (!current) {
      throw new AppError(404, "resource_not_found", "Webhook endpoint not found.");
    }

    const updated: WebhookEndpointRecord = {
      ...current,
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.events !== undefined ? { events: input.events } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    };
    this.endpoints.set(endpointId, updated);
    return updated;
  }

  async rotateEndpointSecret(endpointId: string, secret: string): Promise<WebhookEndpointRecord> {
    const current = this.endpoints.get(endpointId);
    if (!current) {
      throw new AppError(404, "resource_not_found", "Webhook endpoint not found.");
    }

    const updated: WebhookEndpointRecord = {
      ...current,
      secret,
    };
    this.endpoints.set(endpointId, updated);
    return updated;
  }

  async listEndpoints(input: CursorPaginationInput): Promise<CursorPaginationResult<WebhookEndpointRecord>> {
    const items = [...this.endpoints.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
    return this.paginate(items, input);
  }

  async listEnabledEndpointsByEvent(eventType: WebhookEndpointRecord["events"][number]): Promise<WebhookEndpointRecord[]> {
    const items = [...this.endpoints.values()];
    return items.filter((endpoint) => {
      if (!endpoint.enabled) {
        return false;
      }
      if (endpoint.events.length === 0) {
        return true;
      }
      return endpoint.events.includes(eventType);
    });
  }

  async saveDelivery(delivery: WebhookDeliveryRecord): Promise<void> {
    this.deliveries.push(delivery);
  }

  async listDeliveries(input: CursorPaginationInput): Promise<CursorPaginationResult<WebhookDeliveryRecord>> {
    const items = [...this.deliveries].reverse();
    return this.paginate(items, input);
  }

  async saveDeadLetter(deadLetter: StoredWebhookDeadLetterRecord): Promise<void> {
    this.deadLetters.push(deadLetter);
  }

  async listDeadLetters(input: WebhookDeadLetterListInput): Promise<CursorPaginationResult<WebhookDeadLetterRecord>> {
    const items = [...this.deadLetters]
      .reverse()
      .map((item) => this.toPublicDeadLetter(item))
      .filter((item) => {
        if (input.status && item.status !== input.status) {
          return false;
        }
        if (input.eventType && item.event_type !== input.eventType) {
          return false;
        }
        if (input.endpointId && item.endpoint_id !== input.endpointId) {
          return false;
        }
        return true;
      });
    return this.paginate(items, input);
  }

  async getDeadLetterById(deadLetterId: string): Promise<StoredWebhookDeadLetterRecord> {
    const deadLetter = this.deadLetters.find((item) => item.id === deadLetterId);
    if (!deadLetter) {
      throw new AppError(404, "resource_not_found", "Webhook dead letter not found.");
    }
    return deadLetter;
  }

  async updateDeadLetter(deadLetter: StoredWebhookDeadLetterRecord): Promise<void> {
    const index = this.deadLetters.findIndex((item) => item.id === deadLetter.id);
    if (index < 0) {
      throw new AppError(404, "resource_not_found", "Webhook dead letter not found.");
    }
    this.deadLetters[index] = deadLetter;
  }

  private toPublicDeadLetter(deadLetter: StoredWebhookDeadLetterRecord): WebhookDeadLetterRecord {
    return {
      id: deadLetter.id,
      endpoint_id: deadLetter.endpoint_id,
      endpoint_url: deadLetter.endpoint_url,
      event_id: deadLetter.event_id,
      event_type: deadLetter.event_type,
      attempts: deadLetter.attempts,
      status: deadLetter.status,
      replay_count: deadLetter.replay_count,
      failure_reason: deadLetter.failure_reason,
      failed_at: deadLetter.failed_at,
      ...(deadLetter.response_status !== undefined ? { response_status: deadLetter.response_status } : {}),
      ...(deadLetter.error_code ? { error_code: deadLetter.error_code } : {}),
      ...(deadLetter.last_replayed_at ? { last_replayed_at: deadLetter.last_replayed_at } : {}),
    };
  }

  private paginate<T extends { id: string }>(
    items: T[],
    input: CursorPaginationInput,
  ): CursorPaginationResult<T> {
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
}
