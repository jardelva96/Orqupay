interface TokenBucketState {
  tokens: number;
  lastRefillMs: number;
  lastSeenMs: number;
}

interface InMemoryRateLimiterOptions {
  windowSeconds: number;
  maxRequests: number;
  nowMs?: () => number;
  maxIdleWindows?: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
  retryAfterSeconds: number;
}

export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, TokenBucketState>();
  private readonly windowMs: number;
  private readonly refillRatePerMs: number;
  private readonly maxIdleMs: number;
  private readonly nowMs: () => number;
  private consumeCount = 0;

  constructor(private readonly options: InMemoryRateLimiterOptions) {
    this.windowMs = options.windowSeconds * 1000;
    this.refillRatePerMs = options.maxRequests / this.windowMs;
    this.maxIdleMs = this.windowMs * (options.maxIdleWindows ?? 3);
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  consume(identity: string): RateLimitDecision {
    const nowMs = this.nowMs();
    const bucket = this.getOrCreateBucket(identity, nowMs);

    this.refillBucket(bucket, nowMs);
    bucket.lastSeenMs = nowMs;

    const allowed = bucket.tokens >= 1;
    if (allowed) {
      bucket.tokens -= 1;
    }

    const remaining = Math.max(0, Math.floor(bucket.tokens));
    const tokensNeededToRecoverOne = Math.max(0, 1 - bucket.tokens);
    const retryAfterSeconds = this.secondsForTokens(tokensNeededToRecoverOne);
    const resetSeconds = this.secondsForTokens(this.options.maxRequests - bucket.tokens);

    this.consumeCount += 1;
    if (this.consumeCount % 1000 === 0) {
      this.cleanupIdleBuckets(nowMs);
    }

    return {
      allowed,
      limit: this.options.maxRequests,
      remaining,
      resetSeconds,
      retryAfterSeconds: allowed ? 0 : retryAfterSeconds,
    };
  }

  private getOrCreateBucket(identity: string, nowMs: number): TokenBucketState {
    const existing = this.buckets.get(identity);
    if (existing) {
      return existing;
    }
    const bucket: TokenBucketState = {
      tokens: this.options.maxRequests,
      lastRefillMs: nowMs,
      lastSeenMs: nowMs,
    };
    this.buckets.set(identity, bucket);
    return bucket;
  }

  private refillBucket(bucket: TokenBucketState, nowMs: number): void {
    if (nowMs <= bucket.lastRefillMs) {
      return;
    }
    const elapsedMs = nowMs - bucket.lastRefillMs;
    const refillTokens = elapsedMs * this.refillRatePerMs;
    bucket.tokens = Math.min(this.options.maxRequests, bucket.tokens + refillTokens);
    bucket.lastRefillMs = nowMs;
  }

  private secondsForTokens(tokenAmount: number): number {
    if (tokenAmount <= 0) {
      return 1;
    }
    const milliseconds = tokenAmount / this.refillRatePerMs;
    return Math.max(1, Math.ceil(milliseconds / 1000));
  }

  private cleanupIdleBuckets(nowMs: number): void {
    for (const [identity, bucket] of this.buckets.entries()) {
      if (nowMs - bucket.lastSeenMs > this.maxIdleMs) {
        this.buckets.delete(identity);
      }
    }
  }
}
