import { randomUUID } from "node:crypto";
import type {
  PaymentEvent,
  StoredWebhookDeadLetterRecord,
  WebhookDeadLetterRecord,
  WebhookDeliveryRecord,
  WebhookEndpointRecord,
} from "../domain/types.js";
import { AppError } from "../infra/app-error.js";
import type { ClockPort } from "../infra/clock.js";
import type { CursorTokenService } from "../infra/cursor-token.js";
import type { WebhookSenderPort } from "../ports/webhook-sender.js";
import type {
  CursorPaginationInput,
  CursorPaginationResult,
  UpdateWebhookEndpointInput,
  WebhookDeadLetterListInput,
  WebhookRepositoryPort,
} from "../ports/webhook-repository.js";
import { isPermanentWebhookFailure } from "./webhook-delivery-policy.js";
import { signWebhookPayload, webhookSignatureKeyId } from "./webhook-signing.js";

interface CreateWebhookEndpointInput {
  url: string;
  events?: PaymentEvent["type"][];
  secret?: string;
  enabled?: boolean;
}

interface WebhookServiceOptions {
  deliveryTimeoutMs: number;
}

interface ReplayDeadLettersBatchInput {
  limit: number;
  status?: WebhookDeadLetterRecord["status"];
  eventType?: PaymentEvent["type"];
  endpointId?: string;
}

interface ReplayDeadLetterBatchItem {
  dead_letter_id: string;
  status: WebhookDeadLetterRecord["status"];
  replay_count: number;
  outcome: "replayed" | "failed";
  error_code?: string;
}

interface ReplayDeadLettersBatchResult {
  data: ReplayDeadLetterBatchItem[];
  summary: {
    processed: number;
    replayed: number;
    failed: number;
    has_more: boolean;
  };
}

export class WebhookService {
  constructor(
    private readonly repository: WebhookRepositoryPort,
    private readonly sender: WebhookSenderPort,
    private readonly clock: ClockPort,
    private readonly cursorTokens: CursorTokenService,
    private readonly options: WebhookServiceOptions,
  ) {}

  async createEndpoint(input: CreateWebhookEndpointInput): Promise<WebhookEndpointRecord> {
    return this.repository.createEndpoint({
      url: input.url,
      events: input.events ?? [],
      secret: input.secret ?? `whsec_${randomUUID()}`,
      enabled: input.enabled ?? true,
      createdAt: this.clock.nowIso(),
    });
  }

  async getEndpointById(endpointId: string): Promise<WebhookEndpointRecord> {
    return this.repository.getEndpointById(endpointId);
  }

  async updateEndpoint(endpointId: string, input: UpdateWebhookEndpointInput): Promise<WebhookEndpointRecord> {
    return this.repository.updateEndpoint(endpointId, input);
  }

  async rotateEndpointSecret(endpointId: string, secret?: string): Promise<WebhookEndpointRecord> {
    const nextSecret = secret ?? `whsec_${randomUUID()}`;
    return this.repository.rotateEndpointSecret(endpointId, nextSecret);
  }

  async listEndpoints(input: CursorPaginationInput): Promise<CursorPaginationResult<WebhookEndpointRecord>> {
    const internalCursor = input.cursor ? this.cursorTokens.decode(input.cursor) : undefined;
    const page = await this.repository.listEndpoints({
      limit: input.limit,
      ...(internalCursor ? { cursor: internalCursor } : {}),
    });
    return {
      data: page.data,
      hasMore: page.hasMore,
      ...(page.nextCursor ? { nextCursor: this.cursorTokens.encode(page.nextCursor) } : {}),
    };
  }

  async listDeliveries(input: CursorPaginationInput): Promise<CursorPaginationResult<WebhookDeliveryRecord>> {
    const internalCursor = input.cursor ? this.cursorTokens.decode(input.cursor) : undefined;
    const page = await this.repository.listDeliveries({
      limit: input.limit,
      ...(internalCursor ? { cursor: internalCursor } : {}),
    });
    return {
      data: page.data,
      hasMore: page.hasMore,
      ...(page.nextCursor ? { nextCursor: this.cursorTokens.encode(page.nextCursor) } : {}),
    };
  }

  async listDeadLetters(input: WebhookDeadLetterListInput): Promise<CursorPaginationResult<WebhookDeadLetterRecord>> {
    const internalCursor = input.cursor ? this.cursorTokens.decode(input.cursor) : undefined;
    const page = await this.repository.listDeadLetters({
      limit: input.limit,
      ...(input.status ? { status: input.status } : {}),
      ...(input.eventType ? { eventType: input.eventType } : {}),
      ...(input.endpointId ? { endpointId: input.endpointId } : {}),
      ...(internalCursor ? { cursor: internalCursor } : {}),
    });
    return {
      data: page.data,
      hasMore: page.hasMore,
      ...(page.nextCursor ? { nextCursor: this.cursorTokens.encode(page.nextCursor) } : {}),
    };
  }

  async getDeadLetterById(deadLetterId: string): Promise<WebhookDeadLetterRecord> {
    const deadLetter = await this.repository.getDeadLetterById(deadLetterId);
    return this.toPublicDeadLetter(deadLetter);
  }

  async replayDeadLetter(deadLetterId: string): Promise<WebhookDeadLetterRecord> {
    const deadLetter = await this.repository.getDeadLetterById(deadLetterId);
    if (deadLetter.status === "replayed") {
      throw new AppError(409, "dead_letter_already_replayed", "Webhook dead letter already replayed.");
    }

    const endpoint = await this.repository.getEndpointById(deadLetter.endpoint_id);
    if (!endpoint.enabled) {
      throw new AppError(409, "webhook_endpoint_disabled", "Webhook endpoint is disabled.");
    }

    const timestamp = this.clock.nowIso();
    const body = JSON.stringify(deadLetter.event);
    const signature = signWebhookPayload(endpoint.secret, timestamp, body);
    const keyId = webhookSignatureKeyId(endpoint.secret);
    const replayAttempt = deadLetter.attempts + 1;
    const result = await this.sender.send({
      url: endpoint.url,
      headers: {
        "Content-Type": "application/json",
        "X-PMC-Event": deadLetter.event.type,
        "X-PMC-Event-Id": deadLetter.event.id,
        "X-PMC-Timestamp": timestamp,
        "X-PMC-Signature": signature,
        "X-PMC-Signature-Key-Id": keyId,
      },
      body,
      timeoutMs: this.options.deliveryTimeoutMs,
    });

    const delivery: WebhookDeliveryRecord = {
      id: `wd_${randomUUID()}`,
      endpoint_id: endpoint.id,
      event_id: deadLetter.event.id,
      event_type: deadLetter.event.type,
      attempt: replayAttempt,
      status: result.ok ? "succeeded" : "failed",
      created_at: timestamp,
      ...(result.statusCode ? { response_status: result.statusCode } : {}),
      ...(result.errorCode ? { error_code: result.errorCode } : {}),
      ...(result.ok ? { delivered_at: timestamp } : {}),
    };
    await this.repository.saveDelivery(delivery);

    const updated = this.nextDeadLetterState(deadLetter, endpoint.url, replayAttempt, timestamp, result);
    await this.repository.updateDeadLetter(updated);
    return this.toPublicDeadLetter(updated);
  }

  async replayDeadLettersBatch(input: ReplayDeadLettersBatchInput): Promise<ReplayDeadLettersBatchResult> {
    const page = await this.repository.listDeadLetters({
      limit: input.limit,
      ...(input.status ? { status: input.status } : { status: "pending" }),
      ...(input.eventType ? { eventType: input.eventType } : {}),
      ...(input.endpointId ? { endpointId: input.endpointId } : {}),
    });

    const data: ReplayDeadLetterBatchItem[] = [];
    let replayed = 0;
    let failed = 0;

    for (const deadLetter of page.data) {
      try {
        const replayedDeadLetter = await this.replayDeadLetter(deadLetter.id);
        if (replayedDeadLetter.status === "replayed") {
          replayed += 1;
        } else {
          failed += 1;
        }
        data.push({
          dead_letter_id: replayedDeadLetter.id,
          status: replayedDeadLetter.status,
          replay_count: replayedDeadLetter.replay_count,
          outcome: replayedDeadLetter.status === "replayed" ? "replayed" : "failed",
        });
      } catch (error) {
        if (error instanceof AppError) {
          failed += 1;
          data.push({
            dead_letter_id: deadLetter.id,
            status: deadLetter.status,
            replay_count: deadLetter.replay_count,
            outcome: "failed",
            error_code: error.code,
          });
          continue;
        }
        throw error;
      }
    }

    return {
      data,
      summary: {
        processed: page.data.length,
        replayed,
        failed,
        has_more: page.hasMore,
      },
    };
  }

  private nextDeadLetterState(
    deadLetter: StoredWebhookDeadLetterRecord,
    endpointUrl: string,
    replayAttempt: number,
    timestamp: string,
    result: { ok: boolean; statusCode?: number; errorCode?: string },
  ): StoredWebhookDeadLetterRecord {
    const base: StoredWebhookDeadLetterRecord = {
      id: deadLetter.id,
      endpoint_id: deadLetter.endpoint_id,
      endpoint_url: endpointUrl,
      event_id: deadLetter.event_id,
      event_type: deadLetter.event_type,
      attempts: replayAttempt,
      status: deadLetter.status,
      replay_count: deadLetter.replay_count + 1,
      failure_reason: deadLetter.failure_reason,
      failed_at: deadLetter.failed_at,
      event: deadLetter.event,
    };

    if (result.ok) {
      return {
        ...base,
        status: "replayed",
        last_replayed_at: timestamp,
        ...(result.statusCode !== undefined ? { response_status: result.statusCode } : {}),
      };
    }

    const failureReason = isPermanentWebhookFailure(result.statusCode)
      ? "permanent_failure"
      : "max_attempts_exhausted";
    return {
      ...base,
      status: "pending",
      failure_reason: failureReason,
      failed_at: timestamp,
      ...(result.statusCode !== undefined ? { response_status: result.statusCode } : {}),
      ...(result.errorCode ? { error_code: result.errorCode } : {}),
    };
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
}
