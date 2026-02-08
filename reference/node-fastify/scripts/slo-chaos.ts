import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { buildApp } from "../src/server.js";
import { loadRuntimeConfig } from "../src/infra/config.js";

interface SloReport {
  generatedAt: string;
  durationSeconds: number;
  concurrency: number;
  chaosMode: boolean;
  totals: {
    requests: number;
    successes: number;
    failures: number;
    availabilityPct: number;
  };
  latency: {
    avgMs: number;
    p95Ms: number;
    p99Ms: number;
  };
  targets: {
    minAvailabilityPct: number;
    maxP95Ms: number;
    maxP99Ms: number;
  };
  passed: {
    availability: boolean;
    p95: boolean;
    p99: boolean;
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? 0;
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

function parsePositiveFloatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return value;
}

function parseNonNegativeFloatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }
  return value;
}

function pickToken(chaosMode: boolean, unavailableRatio: number): string {
  const random = Math.random();
  if (chaosMode && unavailableRatio > 0 && random < unavailableRatio) {
    return "tok_test_unavailable";
  }
  if (random < 0.25) {
    return "tok_test_transient";
  }
  return "tok_test_visa";
}

async function executeFlow(
  app: ReturnType<typeof buildApp>,
  sequence: number,
  chaosMode: boolean,
  unavailableRatio: number,
): Promise<{ latencyMs: number; success: boolean; failureReason?: string }> {
  const token = pickToken(chaosMode, unavailableRatio);
  const start = performance.now();

  const create = await app.inject({
    method: "POST",
    url: "/v1/payment-intents",
    headers: {
      authorization: "Bearer dev_pmc_key",
      "Idempotency-Key": `slo-chaos-create-${sequence}`,
    },
    payload: {
      amount: 1590,
      currency: "BRL",
      customer: { id: "cus_slo" },
      payment_method: { type: "card", token },
      capture_method: "automatic",
    },
  });

  if (create.statusCode !== 201) {
    return {
      latencyMs: performance.now() - start,
      success: false,
      failureReason: `create_${create.statusCode}_${String(create.json<{ error?: { code?: string } }>().error?.code ?? "unknown")}`,
    };
  }

  const paymentIntentId = create.json<{ id: string }>().id;
  const confirm = await app.inject({
    method: "POST",
    url: `/v1/payment-intents/${paymentIntentId}/confirm`,
    headers: {
      authorization: "Bearer dev_pmc_key",
      "Idempotency-Key": `slo-chaos-confirm-${sequence}`,
    },
  });

  const body = confirm.json<{ status?: string }>();
  const success =
    confirm.statusCode === 200 && (body.status === "succeeded" || body.status === "failed");

  return {
    latencyMs: performance.now() - start,
    success,
    ...(success
      ? {}
      : {
        failureReason: `confirm_${confirm.statusCode}_${String(confirm.json<{ error?: { code?: string } }>().error?.code ?? body.status ?? "unknown")}`,
      }),
  };
}

async function main(): Promise<void> {
  const durationSeconds = parsePositiveIntegerEnv("SLO_TEST_DURATION_SECONDS", 20);
  const concurrency = parsePositiveIntegerEnv("SLO_TEST_CONCURRENCY", 20);
  const minAvailabilityPct = parsePositiveFloatEnv("SLO_MIN_AVAILABILITY_PCT", 99.5);
  const maxP95Ms = parsePositiveFloatEnv("SLO_MAX_P95_MS", 80);
  const maxP99Ms = parsePositiveFloatEnv("SLO_MAX_P99_MS", 140);
  const unavailableRatio = parseNonNegativeFloatEnv("CHAOS_PROVIDER_UNAVAILABLE_RATIO", 0);
  const chaosMode = (process.env.SLO_CHAOS_MODE ?? "true").trim().toLowerCase() !== "false";
  const outputFile = process.env.SLO_OUTPUT_FILE?.trim();

  if (unavailableRatio >= 1) {
    throw new Error("CHAOS_PROVIDER_UNAVAILABLE_RATIO must be lower than 1.");
  }

  const baseConfig = loadRuntimeConfig();
  const app = buildApp({
    ...baseConfig,
    rateLimitEnabled: false,
  });
  await app.ready();

  const deadline = Date.now() + durationSeconds * 1000;
  let sequence = 0;
  let successes = 0;
  let failures = 0;
  const latencies: number[] = [];
  const failureReasons = new Map<string, number>();

  try {
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (Date.now() < deadline) {
          sequence += 1;
          const flowId = sequence;
          const result = await executeFlow(app, flowId, chaosMode, unavailableRatio);
          latencies.push(result.latencyMs);
          if (result.success) {
            successes += 1;
          } else {
            failures += 1;
            if (result.failureReason) {
              failureReasons.set(result.failureReason, (failureReasons.get(result.failureReason) ?? 0) + 1);
            }
          }
        }
      }),
    );
  } finally {
    await app.close();
  }

  const requests = successes + failures;
  const avgMs = latencies.reduce((sum, value) => sum + value, 0) / Math.max(1, latencies.length);
  const p95Ms = percentile(latencies, 95);
  const p99Ms = percentile(latencies, 99);
  const availabilityPct = (successes / Math.max(1, requests)) * 100;

  const availabilityPass = availabilityPct >= minAvailabilityPct;
  const p95Pass = p95Ms <= maxP95Ms;
  const p99Pass = p99Ms <= maxP99Ms;

  console.log("\nSLO chaos report");
  console.log(`requests: ${requests}`);
  console.log(`successes: ${successes}`);
  console.log(`failures: ${failures}`);
  console.log(`availability: ${availabilityPct.toFixed(3)}% (target >= ${minAvailabilityPct.toFixed(3)}%)`);
  console.log(`avg latency: ${avgMs.toFixed(2)} ms`);
  console.log(`p95 latency: ${p95Ms.toFixed(2)} ms (target <= ${maxP95Ms.toFixed(2)} ms)`);
  console.log(`p99 latency: ${p99Ms.toFixed(2)} ms (target <= ${maxP99Ms.toFixed(2)} ms)`);
  if (failureReasons.size > 0) {
    const topReasons = [...failureReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log("top failures:");
    for (const [reason, count] of topReasons) {
      console.log(`- ${reason}: ${count}`);
    }
  }

  const report: SloReport = {
    generatedAt: new Date().toISOString(),
    durationSeconds,
    concurrency,
    chaosMode,
    totals: {
      requests,
      successes,
      failures,
      availabilityPct,
    },
    latency: {
      avgMs,
      p95Ms,
      p99Ms,
    },
    targets: {
      minAvailabilityPct,
      maxP95Ms,
      maxP99Ms,
    },
    passed: {
      availability: availabilityPass,
      p95: p95Pass,
      p99: p99Pass,
    },
  };

  if (outputFile) {
    await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`slo report written to ${outputFile}`);
  }

  if (!availabilityPass || !p95Pass || !p99Pass) {
    throw new Error(
      [
        "slo target not met.",
        `availability pass: ${availabilityPass}`,
        `p95 pass: ${p95Pass}`,
        `p99 pass: ${p99Pass}`,
      ].join(" "),
    );
  }
}

await main();
