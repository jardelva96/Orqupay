import { createHash } from "node:crypto";

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalize(item));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    const normalizedEntries = entries.map(([key, item]) => [key, normalize(item)]);
    return Object.fromEntries(normalizedEntries);
  }
  return value;
}

export function fingerprintPayload(payload: unknown): string {
  const normalized = normalize(payload);
  const json = JSON.stringify(normalized);
  return createHash("sha256").update(json).digest("hex");
}

