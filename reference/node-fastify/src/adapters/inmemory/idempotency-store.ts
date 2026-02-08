import type {
  IdempotencyRecord,
  IdempotencyStorePort,
} from "../../ports/idempotency-store.js";
import type { ClockPort } from "../../infra/clock.js";

interface InMemoryIdempotencyStoreOptions {
  ttlSeconds?: number;
  clock?: ClockPort;
}

const defaultClock: ClockPort = {
  nowIso() {
    return new Date().toISOString();
  },
};

export class InMemoryIdempotencyStore implements IdempotencyStorePort {
  private readonly scopes = new Map<string, Map<string, IdempotencyRecord<unknown>>>();
  private readonly keyLocks = new Map<string, { tail: Promise<void>; pending: number }>();
  private readonly ttlMs: number;
  private readonly clock: ClockPort;

  constructor(options: InMemoryIdempotencyStoreOptions = {}) {
    this.ttlMs = (options.ttlSeconds ?? 86400) * 1000;
    this.clock = options.clock ?? defaultClock;
  }

  async get<TBody>(scope: string, key: string): Promise<IdempotencyRecord<TBody> | null> {
    const scopeMap = this.scopes.get(scope);
    if (!scopeMap) {
      return null;
    }
    const entry = scopeMap.get(key);
    if (!entry) {
      return null;
    }
    if (this.hasExpired(entry.createdAt)) {
      scopeMap.delete(key);
      if (scopeMap.size === 0) {
        this.scopes.delete(scope);
      }
      return null;
    }
    return entry as IdempotencyRecord<TBody>;
  }

  async put<TBody>(scope: string, key: string, record: IdempotencyRecord<TBody>): Promise<void> {
    const scopeMap = this.scopes.get(scope) ?? new Map<string, IdempotencyRecord<unknown>>();
    scopeMap.set(key, record as IdempotencyRecord<unknown>);
    this.scopes.set(scope, scopeMap);
  }

  async withKeyLock<TOutput>(
    scope: string,
    key: string,
    operation: () => Promise<TOutput>,
  ): Promise<TOutput> {
    const lockKey = `${scope}:${key}`;
    const lockState = this.keyLocks.get(lockKey) ?? { tail: Promise.resolve(), pending: 0 };
    this.keyLocks.set(lockKey, lockState);
    lockState.pending += 1;

    const acquire = lockState.tail;
    let releaseTail: () => void = () => {};
    const releaseSignal = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    lockState.tail = lockState.tail.then(() => releaseSignal);

    await acquire;
    try {
      return await operation();
    } finally {
      releaseTail();
      lockState.pending -= 1;
      if (lockState.pending === 0) {
        this.keyLocks.delete(lockKey);
      }
    }
  }

  private hasExpired(createdAt: string): boolean {
    const createdAtMs = Date.parse(createdAt);
    if (!Number.isFinite(createdAtMs)) {
      return true;
    }
    const nowMs = Date.parse(this.clock.nowIso());
    if (!Number.isFinite(nowMs)) {
      return false;
    }
    return nowMs - createdAtMs >= this.ttlMs;
  }
}
