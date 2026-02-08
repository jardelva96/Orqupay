import type { PaymentEvent } from "../domain/types.js";

type LabelSet = Record<string, string>;

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function buildLabelKey(labelNames: string[], labels: LabelSet): string {
  return labelNames.map((name) => `${name}=${labels[name] ?? ""}`).join("|");
}

function parseLabelKey(labelNames: string[], key: string): LabelSet {
  const parts = key.split("|");
  const labels: LabelSet = {};
  for (const [index, name] of labelNames.entries()) {
    const value = parts[index];
    labels[name] = value ? value.slice(name.length + 1) : "";
  }
  return labels;
}

function formatLabels(labels: LabelSet): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) {
    return "";
  }
  const inner = entries.map(([name, value]) => `${name}="${escapeLabelValue(value)}"`).join(",");
  return `{${inner}}`;
}

class CounterMetric {
  private readonly values = new Map<string, number>();

  constructor(
    private readonly name: string,
    private readonly help: string,
    private readonly labelNames: string[],
  ) {}

  inc(labels: LabelSet, value = 1): void {
    const key = buildLabelKey(this.labelNames, labels);
    const current = this.values.get(key) ?? 0;
    this.values.set(key, current + value);
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, value] of this.values.entries()) {
      const labels = parseLabelKey(this.labelNames, key);
      lines.push(`${this.name}${formatLabels(labels)} ${value}`);
    }
    return lines;
  }
}

class HistogramMetric {
  private readonly values = new Map<string, { count: number; sum: number; buckets: number[] }>();

  constructor(
    private readonly name: string,
    private readonly help: string,
    private readonly labelNames: string[],
    private readonly buckets: number[],
  ) {}

  observe(labels: LabelSet, value: number): void {
    const key = buildLabelKey(this.labelNames, labels);
    const current =
      this.values.get(key) ?? {
        count: 0,
        sum: 0,
        buckets: this.buckets.map(() => 0),
      };
    current.count += 1;
    current.sum += value;
    for (const [index, bucket] of this.buckets.entries()) {
      if (value <= bucket) {
        current.buckets[index] = (current.buckets[index] ?? 0) + 1;
      }
    }
    this.values.set(key, current);
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, stats] of this.values.entries()) {
      const baseLabels = parseLabelKey(this.labelNames, key);
      for (const [index, bucket] of this.buckets.entries()) {
        lines.push(
          `${this.name}_bucket${formatLabels({ ...baseLabels, le: String(bucket) })} ${stats.buckets[index] ?? 0}`,
        );
      }
      lines.push(`${this.name}_bucket${formatLabels({ ...baseLabels, le: "+Inf" })} ${stats.count}`);
      lines.push(`${this.name}_sum${formatLabels(baseLabels)} ${stats.sum}`);
      lines.push(`${this.name}_count${formatLabels(baseLabels)} ${stats.count}`);
    }
    return lines;
  }
}

export class PmcMetricsRegistry {
  private readonly httpRequests = new CounterMetric(
    "pmc_http_requests_total",
    "Total number of HTTP requests handled by route, method, and status code.",
    ["method", "route", "status_code"],
  );
  private readonly httpDuration = new HistogramMetric(
    "pmc_http_request_duration_seconds",
    "HTTP request duration in seconds by route and method.",
    ["method", "route"],
    [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  );
  private readonly idempotencyReplays = new CounterMetric(
    "pmc_idempotency_replays_total",
    "Total number of idempotent replay responses by operation.",
    ["operation"],
  );
  private readonly deadLetterReplayOutcomes = new CounterMetric(
    "pmc_webhook_dead_letter_replays_total",
    "Total number of webhook dead-letter replay outcomes.",
    ["outcome"],
  );
  private readonly rateLimitRejections = new CounterMetric(
    "pmc_http_rate_limited_total",
    "Total number of HTTP requests rejected by rate limiting.",
    ["scope"],
  );
  private readonly paymentEvents = new CounterMetric(
    "pmc_payment_events_total",
    "Total number of published payment lifecycle events by type.",
    ["event_type"],
  );
  private readonly paymentIntentStatusEvents = new CounterMetric(
    "pmc_payment_intent_status_total",
    "Total number of payment intent lifecycle transitions by status.",
    ["status"],
  );
  private readonly refundStatusEvents = new CounterMetric(
    "pmc_refund_status_total",
    "Total number of refund lifecycle outcomes by status.",
    ["status"],
  );

  recordHttpRequest(method: string, route: string, statusCode: number, durationSeconds: number): void {
    this.httpRequests.inc({
      method: method.toUpperCase(),
      route,
      status_code: String(statusCode),
    });
    this.httpDuration.observe(
      {
        method: method.toUpperCase(),
        route,
      },
      durationSeconds,
    );
  }

  recordIdempotencyReplay(operation: string): void {
    this.idempotencyReplays.inc({ operation });
  }

  recordDeadLetterReplayOutcome(outcome: "replayed" | "failed"): void {
    this.deadLetterReplayOutcomes.inc({ outcome });
  }

  recordRateLimitRejection(scope: string): void {
    this.rateLimitRejections.inc({ scope });
  }

  recordPublishedEvent(eventType: PaymentEvent["type"]): void {
    this.paymentEvents.inc({ event_type: eventType });

    switch (eventType) {
      case "payment_intent.created":
        this.paymentIntentStatusEvents.inc({ status: "requires_confirmation" });
        break;
      case "payment_intent.processing":
        this.paymentIntentStatusEvents.inc({ status: "processing" });
        break;
      case "payment_intent.requires_action":
        this.paymentIntentStatusEvents.inc({ status: "requires_action" });
        break;
      case "payment_intent.succeeded":
        this.paymentIntentStatusEvents.inc({ status: "succeeded" });
        break;
      case "payment_intent.failed":
        this.paymentIntentStatusEvents.inc({ status: "failed" });
        break;
      case "payment_intent.canceled":
        this.paymentIntentStatusEvents.inc({ status: "canceled" });
        break;
      case "refund.succeeded":
        this.refundStatusEvents.inc({ status: "succeeded" });
        break;
      case "refund.failed":
        this.refundStatusEvents.inc({ status: "failed" });
        break;
    }
  }

  renderPrometheus(): string {
    const lines = [
      ...this.httpRequests.render(),
      ...this.httpDuration.render(),
      ...this.idempotencyReplays.render(),
      ...this.deadLetterReplayOutcomes.render(),
      ...this.rateLimitRejections.render(),
      ...this.paymentEvents.render(),
      ...this.paymentIntentStatusEvents.render(),
      ...this.refundStatusEvents.render(),
    ];
    return `${lines.join("\n")}\n`;
  }
}
