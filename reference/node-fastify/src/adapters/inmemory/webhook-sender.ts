import type { WebhookSendInput, WebhookSendResult, WebhookSenderPort } from "../../ports/webhook-sender.js";

const TRANSIENT_FAILURE = "transient_webhook_error";

export class InMemoryWebhookSender implements WebhookSenderPort {
  private readonly attemptsByUrl = new Map<string, number>();

  async send(input: WebhookSendInput): Promise<WebhookSendResult> {
    const currentAttempts = (this.attemptsByUrl.get(input.url) ?? 0) + 1;
    this.attemptsByUrl.set(input.url, currentAttempts);

    if (input.url.includes("always-fail")) {
      return { ok: false, errorCode: TRANSIENT_FAILURE };
    }

    if (input.url.includes("bad-request")) {
      return { ok: false, statusCode: 400, errorCode: "invalid_webhook_request" };
    }

    if (input.url.includes("rate-limit") && currentAttempts < 3) {
      return { ok: false, statusCode: 429, errorCode: "rate_limited" };
    }

    if (input.url.includes("flaky") && currentAttempts % 2 === 1) {
      return { ok: false, errorCode: TRANSIENT_FAILURE };
    }

    return { ok: true, statusCode: 200 };
  }
}
