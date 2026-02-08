import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { buildApp } from "../src/server.js";

interface ScenarioInput {
  name: string;
  token: string;
}

interface ScenarioResult {
  name: string;
  iterations: number;
  successRate: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
}

interface BenchmarkReport {
  generatedAt: string;
  nodeVersion: string;
  iterations: number;
  thresholds: {
    maxFailoverAvgDeltaMs: number;
    maxFailoverP95DeltaMs: number;
  };
  scenarios: {
    direct: ScenarioResult;
    failover: ScenarioResult;
  };
  deltas: {
    avgMs: number;
    p95Ms: number;
  };
  withinThresholds: {
    avg: boolean;
    p95: boolean;
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

async function executeFlow(
  scenario: ScenarioInput,
  app: ReturnType<typeof buildApp>,
  keySuffix: string,
): Promise<{ latencyMs: number; success: boolean }> {
  const start = performance.now();
  const create = await app.inject({
    method: "POST",
    url: "/v1/payment-intents",
    headers: {
      authorization: "Bearer dev_pmc_key",
      "Idempotency-Key": `${scenario.name}-${keySuffix}`,
    },
    payload: {
      amount: 1290,
      currency: "BRL",
      customer: { id: "cus_benchmark" },
      payment_method: { type: "card", token: scenario.token },
      capture_method: "automatic",
    },
  });

  if (create.statusCode !== 201) {
    return { latencyMs: performance.now() - start, success: false };
  }

  const paymentIntentId = create.json<{ id: string }>().id;
  const confirm = await app.inject({
    method: "POST",
    url: `/v1/payment-intents/${paymentIntentId}/confirm`,
    headers: {
      authorization: "Bearer dev_pmc_key",
      "Idempotency-Key": `${scenario.name}-confirm-${keySuffix}`,
    },
  });

  const success = confirm.statusCode === 200 && confirm.json<{ status: string }>().status === "succeeded";
  return { latencyMs: performance.now() - start, success };
}

function summarizeScenario(name: string, latencies: number[], successCount: number): ScenarioResult {
  const iterations = latencies.length;
  const avgMs = latencies.reduce((sum, value) => sum + value, 0) / Math.max(1, iterations);

  return {
    name,
    iterations: latencies.length,
    successRate: (successCount / Math.max(1, iterations)) * 100,
    avgMs,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
  };
}

function formatNumber(value: number): string {
  return value.toFixed(2);
}

function parsePositiveFloatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const iterations = Number(process.env.BENCH_ITERATIONS ?? "200");
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new Error("BENCH_ITERATIONS must be a positive integer.");
  }
  const maxFailoverAvgDeltaMs = parsePositiveFloatEnv("BENCH_FAILOVER_MAX_AVG_DELTA_MS", 5);
  const maxFailoverP95DeltaMs = parsePositiveFloatEnv("BENCH_FAILOVER_MAX_P95_DELTA_MS", 10);
  const outputFile = process.env.BENCH_OUTPUT_FILE?.trim();

  const scenarios: ScenarioInput[] = [
    { name: "direct_authorization", token: "tok_test_visa" },
    { name: "failover_authorization", token: "tok_test_transient" },
  ];
  const [directScenario, failoverScenario] = scenarios;
  if (!directScenario || !failoverScenario) {
    throw new Error("Benchmark scenarios are not configured.");
  }

  const app = buildApp();
  await app.ready();

  for (let warmupIndex = 0; warmupIndex < 30; warmupIndex += 1) {
    for (const scenario of scenarios) {
      await executeFlow(scenario, app, `warmup-${warmupIndex}`);
    }
  }

  const latenciesByScenario = new Map<string, number[]>();
  const successesByScenario = new Map<string, number>();
  for (const scenario of scenarios) {
    latenciesByScenario.set(scenario.name, []);
    successesByScenario.set(scenario.name, 0);
  }

  for (let index = 0; index < iterations; index += 1) {
    const order = index % 2 === 0 ? scenarios : [...scenarios].reverse();
    for (const scenario of order) {
      const result = await executeFlow(scenario, app, `run-${index}`);
      latenciesByScenario.get(scenario.name)?.push(result.latencyMs);
      if (result.success) {
        successesByScenario.set(scenario.name, (successesByScenario.get(scenario.name) ?? 0) + 1);
      }
    }
  }

  await app.close();

  const primary = summarizeScenario(
    directScenario.name,
    latenciesByScenario.get(directScenario.name) ?? [],
    successesByScenario.get(directScenario.name) ?? 0,
  );
  const failover = summarizeScenario(
    failoverScenario.name,
    latenciesByScenario.get(failoverScenario.name) ?? [],
    successesByScenario.get(failoverScenario.name) ?? 0,
  );

  const deltaAvg = failover.avgMs - primary.avgMs;
  const deltaP95 = failover.p95Ms - primary.p95Ms;

  console.log("\nBenchmark comparison (ms)");
  console.log("| Scenario | Iterations | Success % | Avg | P50 | P95 |");
  console.log("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const scenario of [primary, failover]) {
    console.log(
      `| ${scenario.name} | ${scenario.iterations} | ${formatNumber(scenario.successRate)} | ${formatNumber(scenario.avgMs)} | ${formatNumber(scenario.p50Ms)} | ${formatNumber(scenario.p95Ms)} |`,
    );
  }
  console.log("\nDelta failover - direct");
  console.log(`avg: ${formatNumber(deltaAvg)} ms`);
  console.log(`p95: ${formatNumber(deltaP95)} ms`);

  const avgRegression = Math.max(0, deltaAvg);
  const p95Regression = Math.max(0, deltaP95);
  const withinAvgThreshold = avgRegression <= maxFailoverAvgDeltaMs;
  const withinP95Threshold = p95Regression <= maxFailoverP95DeltaMs;

  console.log("\nRegression guardrails");
  console.log(
    `avg regression <= ${formatNumber(maxFailoverAvgDeltaMs)} ms: ${withinAvgThreshold ? "PASS" : "FAIL"}`,
  );
  console.log(
    `p95 regression <= ${formatNumber(maxFailoverP95DeltaMs)} ms: ${withinP95Threshold ? "PASS" : "FAIL"}`,
  );

  const report: BenchmarkReport = {
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    iterations,
    thresholds: {
      maxFailoverAvgDeltaMs,
      maxFailoverP95DeltaMs,
    },
    scenarios: {
      direct: primary,
      failover,
    },
    deltas: {
      avgMs: deltaAvg,
      p95Ms: deltaP95,
    },
    withinThresholds: {
      avg: withinAvgThreshold,
      p95: withinP95Threshold,
    },
  };

  if (outputFile) {
    await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`benchmark report written to ${outputFile}`);
  }

  if (!withinAvgThreshold || !withinP95Threshold) {
    throw new Error(
      [
        "benchmark regression threshold exceeded.",
        `avg regression: ${formatNumber(avgRegression)} ms (max ${formatNumber(maxFailoverAvgDeltaMs)} ms)`,
        `p95 regression: ${formatNumber(p95Regression)} ms (max ${formatNumber(maxFailoverP95DeltaMs)} ms)`,
      ].join(" "),
    );
  }
}

await main();
