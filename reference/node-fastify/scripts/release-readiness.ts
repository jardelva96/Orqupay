import { spawnSync } from "node:child_process";

interface Check {
  name: string;
  command: string;
  required: boolean;
}

function runCommand(command: string): number {
  const result = spawnSync(command, {
    stdio: "inherit",
    shell: true,
    env: process.env,
  });

  if (result.error) {
    console.error(`release:readiness failed to start '${command}': ${result.error.message}`);
    return 1;
  }

  return result.status ?? 1;
}

function runCheck(check: Check): boolean {
  console.log(`\n[release:readiness] ${check.name}`);
  const code = runCommand(check.command);
  if (code === 0) {
    console.log(`[release:readiness] PASS: ${check.name}`);
    return true;
  }
  const level = check.required ? "FAIL" : "WARN";
  console.error(`[release:readiness] ${level}: ${check.name}`);
  return !check.required;
}

function resolveChecks(): Check[] {
  const checks: Check[] = [
    {
      name: "Quality gate (lint + typecheck + coverage + contracts + events)",
      command: "npm run -s quality",
      required: true,
    },
    {
      name: "Benchmark regression guardrail",
      command: "npm run -s benchmark:compare",
      required: true,
    },
    {
      name: "SLO chaos baseline",
      command: "npm run -s slo:chaos",
      required: true,
    },
  ];

  const forcedDr = process.env.RUN_DR_DRILL === "true";
  const durableConfigured =
    process.env.PMC_EVENT_BUS_BACKEND === "durable" &&
    Boolean(process.env.PMC_POSTGRES_URL) &&
    Boolean(process.env.PMC_REDIS_URL);

  if (forcedDr || durableConfigured) {
    checks.push({
      name: "DR drill",
      command: "npm run -s dr:drill",
      required: forcedDr,
    });
  } else {
    console.log(
      "[release:readiness] DR drill skipped (set RUN_DR_DRILL=true and durable env vars to enforce it).",
    );
  }

  return checks;
}

function main(): void {
  const checks = resolveChecks();
  let allGood = true;

  for (const check of checks) {
    const ok = runCheck(check);
    if (!ok) {
      allGood = false;
    }
  }

  if (!allGood) {
    process.exitCode = 1;
    console.error("\n[release:readiness] One or more required checks failed.");
    return;
  }

  console.log("\n[release:readiness] All required checks passed.");
}

main();
