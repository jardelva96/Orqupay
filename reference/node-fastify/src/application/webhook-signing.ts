import { createHash, createHmac } from "node:crypto";

export function signWebhookPayload(secret: string, timestamp: string, body: string): string {
  const signedPayload = `${timestamp}.${body}`;
  return createHmac("sha256", secret).update(signedPayload).digest("hex");
}

export function webhookSignatureKeyId(secret: string): string {
  const digest = createHash("sha256").update(secret).digest("hex");
  return `whk_${digest.slice(0, 12)}`;
}
