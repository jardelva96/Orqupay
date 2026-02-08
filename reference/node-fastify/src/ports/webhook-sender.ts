export interface WebhookSendInput {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export interface WebhookSendResult {
  ok: boolean;
  statusCode?: number;
  errorCode?: string;
}

export interface WebhookSenderPort {
  send(input: WebhookSendInput): Promise<WebhookSendResult>;
}

