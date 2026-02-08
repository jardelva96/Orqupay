import { writeFile } from "node:fs/promises";
import { buildApp } from "../src/server.js";
import { loadRuntimeConfig } from "../src/infra/config.js";

interface DrillEvent {
  id: string;
  occurred_at: string;
}

interface DrDrillReport {
  generatedAt: string;
  runId: string;
  targets: {
    rtoSeconds: number;
    rpoSeconds: number;
  };
  measurements: {
    disruptionAt: string;
    restoredAt: string;
    rtoSeconds: number;
    rpoSeconds: number;
    expectedEventCount: number;
    recoveredEventCount: number;
    lostEventCount: number;
  };
  config: {
    idempotencyBackend: string;
    rateLimitBackend: string;
    eventBusBackend: string;
    simulatedOutageSeconds: number;
    sampleSize: number;
  };
  passed: {
    rto: boolean;
    rpo: boolean;
  };
}

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function parseNonNegativeIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

function withAuth(headers?: Record<string, string>): Record<string, string> {
  return {
    authorization: "Bearer dev_pmc_key",
    ...(headers ?? {}),
  };
}

function withAuthAndIdempotency(key: string): Record<string, string> {
  return withAuth({ "Idempotency-Key": key });
}

async function createAndConfirmPayment(
  app: ReturnType<typeof buildApp>,
  runId: string,
  sequence: number,
): Promise<string> {
  const create = await app.inject({
    method: "POST",
    url: "/v1/payment-intents",
    headers: withAuthAndIdempotency(`dr-create-${runId}-${sequence}`),
    payload: {
      amount: 1790,
      currency: "BRL",
      customer: { id: `cus_dr_${runId}` },
      payment_method: { type: "card", token: "tok_test_visa" },
      capture_method: "automatic",
    },
  });

  if (create.statusCode !== 201) {
    throw new Error(`create flow failed: status=${create.statusCode} body=${create.body}`);
  }

  const paymentIntentId = create.json<{ id: string }>().id;
  const confirm = await app.inject({
    method: "POST",
    url: `/v1/payment-intents/${paymentIntentId}/confirm`,
    headers: withAuthAndIdempotency(`dr-confirm-${runId}-${sequence}`),
  });
  if (confirm.statusCode !== 200) {
    throw new Error(`confirm flow failed: status=${confirm.statusCode} body=${confirm.body}`);
  }

  return paymentIntentId;
}

async function listEventsByPaymentIntent(
  app: ReturnType<typeof buildApp>,
  paymentIntentId: string,
): Promise<DrillEvent[]> {
  const collected: DrillEvent[] = [];
  let nextCursor: string | null = null;

  do {
    const queryParts = [`payment_intent_id=${encodeURIComponent(paymentIntentId)}`, "limit=50"];
    if (nextCursor) {
      queryParts.push(`cursor=${encodeURIComponent(nextCursor)}`);
    }
    const response = await app.inject({
      method: "GET",
      url: `/v1/payment-events?${queryParts.join("&")}`,
      headers: withAuth(),
    });
    if (response.statusCode !== 200) {
      throw new Error(`events query failed: status=${response.statusCode} body=${response.body}`);
    }

    const body = response.json<{
      data: Array<{ id: string; occurred_at: string }>;
      pagination: { next_cursor: string | null; has_more: boolean };
    }>();
    for (const event of body.data) {
      collected.push({ id: event.id, occurred_at: event.occurred_at });
    }
    nextCursor = body.pagination.has_more ? body.pagination.next_cursor : null;
  } while (nextCursor);

  return collected;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const sampleSize = parsePositiveIntegerEnv("DR_SAMPLE_SIZE", 5);
  const simulatedOutageSeconds = parseNonNegativeIntegerEnv("DR_SIMULATED_OUTAGE_SECONDS", 2);
  const rtoTargetSeconds = parsePositiveIntegerEnv("DR_RTO_TARGET_SECONDS", 300);
  const rpoTargetSeconds = parseNonNegativeIntegerEnv("DR_RPO_TARGET_SECONDS", 60);
  const outputFile = process.env.DR_OUTPUT_FILE?.trim();
  const requireDurable = (process.env.DR_REQUIRE_DURABLE ?? "true").trim().toLowerCase() !== "false";
  const runId = `${Date.now()}`;

  if (requireDurable && config.eventBusBackend !== "durable") {
    throw new Error("DR drill requires durable event bus. Set PMC_EVENT_BUS_BACKEND=durable.");
  }

  let app = buildApp(config);
  await app.ready();

  const paymentIntentIds: string[] = [];
  const preDisruptionEvents = new Map<string, DrillEvent>();
  try {
    for (let index = 0; index < sampleSize; index += 1) {
      const paymentIntentId = await createAndConfirmPayment(app, runId, index);
      paymentIntentIds.push(paymentIntentId);
    }

    for (const paymentIntentId of paymentIntentIds) {
      const events = await listEventsByPaymentIntent(app, paymentIntentId);
      for (const event of events) {
        preDisruptionEvents.set(event.id, event);
      }
    }

    const disruptionAt = new Date();
    await app.close();
    await sleep(simulatedOutageSeconds * 1000);

    app = buildApp(config);
    await app.ready();
    const restoredAt = new Date();

    const postDisruptionEvents = new Map<string, DrillEvent>();
    for (const paymentIntentId of paymentIntentIds) {
      const events = await listEventsByPaymentIntent(app, paymentIntentId);
      for (const event of events) {
        postDisruptionEvents.set(event.id, event);
      }
    }

    const lostEvents = [...preDisruptionEvents.values()].filter((event) => !postDisruptionEvents.has(event.id));
    const oldestLostEventMs =
      lostEvents.length > 0
        ? Math.min(...lostEvents.map((event) => Date.parse(event.occurred_at)).filter(Number.isFinite))
        : Number.NaN;

    const rtoSeconds = Math.max(0, (restoredAt.getTime() - disruptionAt.getTime()) / 1000);
    const rpoSeconds =
      lostEvents.length === 0 || !Number.isFinite(oldestLostEventMs)
        ? 0
        : Math.max(0, (disruptionAt.getTime() - oldestLostEventMs) / 1000);

    const report: DrDrillReport = {
      generatedAt: new Date().toISOString(),
      runId,
      targets: {
        rtoSeconds: rtoTargetSeconds,
        rpoSeconds: rpoTargetSeconds,
      },
      measurements: {
        disruptionAt: disruptionAt.toISOString(),
        restoredAt: restoredAt.toISOString(),
        rtoSeconds,
        rpoSeconds,
        expectedEventCount: preDisruptionEvents.size,
        recoveredEventCount: postDisruptionEvents.size,
        lostEventCount: lostEvents.length,
      },
      config: {
        idempotencyBackend: config.idempotencyBackend ?? "memory",
        rateLimitBackend: config.rateLimitBackend ?? "memory",
        eventBusBackend: config.eventBusBackend ?? "memory",
        simulatedOutageSeconds,
        sampleSize,
      },
      passed: {
        rto: rtoSeconds <= rtoTargetSeconds,
        rpo: lostEvents.length === 0 && rpoSeconds <= rpoTargetSeconds,
      },
    };

    console.log("\nDR drill report");
    console.log(`run_id: ${report.runId}`);
    console.log(`event_bus_backend: ${report.config.eventBusBackend}`);
    console.log(`idempotency_backend: ${report.config.idempotencyBackend}`);
    console.log(`sample_size: ${report.config.sampleSize}`);
    console.log(`simulated_outage_seconds: ${report.config.simulatedOutageSeconds}`);
    console.log(`rto_seconds: ${report.measurements.rtoSeconds.toFixed(2)} (target <= ${report.targets.rtoSeconds})`);
    console.log(`rpo_seconds: ${report.measurements.rpoSeconds.toFixed(2)} (target <= ${report.targets.rpoSeconds})`);
    console.log(`expected_events: ${report.measurements.expectedEventCount}`);
    console.log(`recovered_events: ${report.measurements.recoveredEventCount}`);
    console.log(`lost_events: ${report.measurements.lostEventCount}`);

    if (outputFile) {
      await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      console.log(`dr report written to ${outputFile}`);
    }

    if (!report.passed.rto || !report.passed.rpo) {
      throw new Error(
        `dr target not met. rto_pass=${report.passed.rto} rpo_pass=${report.passed.rpo}`,
      );
    }
  } finally {
    await app.close().catch(() => undefined);
  }
}

await main();
