import { randomUUID } from "node:crypto";
import type {
  PaymentEvent,
  WebhookDeadLetterFailureReason,
  StoredWebhookDeadLetterRecord,
  WebhookDeliveryRecord,
} from "../domain/types.js";
import type { ClockPort } from "../infra/clock.js";
import type { WebhookRepositoryPort } from "../ports/webhook-repository.js";
import type { WebhookSenderPort } from "../ports/webhook-sender.js";
import { isPermanentWebhookFailure } from "./webhook-delivery-policy.js";
import { signWebhookPayload, webhookSignatureKeyId } from "./webhook-signing.js";

interface WebhookDispatcherOptions {
  maxAttempts: number;
  timeoutMs: number;
}

export class WebhookDispatcher {
  constructor(
    private readonly repository: WebhookRepositoryPort,
    private readonly sender: WebhookSenderPort,
    private readonly clock: ClockPort,
    private readonly options: WebhookDispatcherOptions,
  ) {}

  async dispatch(event: PaymentEvent): Promise<void> {
    const endpoints = await this.repository.listEnabledEndpointsByEvent(event.type);
    const body = JSON.stringify(event);

    for (const endpoint of endpoints) {
      let delivered = false;
      let lastFailure:
        | {
            attempt: number;
            at: string;
            statusCode?: number;
            errorCode?: string;
          }
        | undefined;
      let finalFailureReason: WebhookDeadLetterFailureReason = "max_attempts_exhausted";

      for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
        const timestamp = this.clock.nowIso();
        const signature = signWebhookPayload(endpoint.secret, timestamp, body);
        const keyId = webhookSignatureKeyId(endpoint.secret);
        const result = await this.sender.send({
          url: endpoint.url,
          headers: {
            "Content-Type": "application/json",
            "X-PMC-Event": event.type,
            "X-PMC-Event-Id": event.id,
            "X-PMC-Timestamp": timestamp,
            "X-PMC-Signature": signature,
            "X-PMC-Signature-Key-Id": keyId,
          },
          body,
          timeoutMs: this.options.timeoutMs,
        });

        const delivery: WebhookDeliveryRecord = {
          id: `wd_${randomUUID()}`,
          endpoint_id: endpoint.id,
          event_id: event.id,
          event_type: event.type,
          attempt,
          status: result.ok ? "succeeded" : "failed",
          created_at: timestamp,
          ...(result.statusCode ? { response_status: result.statusCode } : {}),
          ...(result.errorCode ? { error_code: result.errorCode } : {}),
          ...(result.ok ? { delivered_at: timestamp } : {}),
        };

        await this.repository.saveDelivery(delivery);

        if (result.ok) {
          delivered = true;
          break;
        }

        lastFailure = {
          attempt,
          at: timestamp,
          ...(result.statusCode ? { statusCode: result.statusCode } : {}),
          ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        };
        if (isPermanentWebhookFailure(result.statusCode)) {
          finalFailureReason = "permanent_failure";
          break;
        }
      }

      if (!delivered && lastFailure) {
        const deadLetter: StoredWebhookDeadLetterRecord = {
          id: `wdl_${randomUUID()}`,
          endpoint_id: endpoint.id,
          endpoint_url: endpoint.url,
          event_id: event.id,
          event_type: event.type,
          attempts: lastFailure.attempt,
          status: "pending",
          replay_count: 0,
          failure_reason: finalFailureReason,
          failed_at: lastFailure.at,
          event,
          ...(lastFailure.statusCode ? { response_status: lastFailure.statusCode } : {}),
          ...(lastFailure.errorCode ? { error_code: lastFailure.errorCode } : {}),
        };
        await this.repository.saveDeadLetter(deadLetter);
      }
    }
  }
}
