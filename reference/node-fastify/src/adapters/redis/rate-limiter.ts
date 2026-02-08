import type { Redis } from "ioredis";
import type { RateLimitDecision } from "../../infra/rate-limiter.js";
import type { RateLimiterPort } from "../../ports/rate-limiter.js";

interface RedisRateLimiterOptions {
  windowSeconds: number;
  maxRequests: number;
  keyPrefix: string;
  maxIdleWindows?: number;
  nowMs?: () => number;
}

const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local now_ms = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local max_requests = tonumber(ARGV[3])
local max_idle_ms = tonumber(ARGV[4])

local refill_rate = max_requests / window_ms
local tokens = tonumber(redis.call('HGET', key, 'tokens'))
local last_refill_ms = tonumber(redis.call('HGET', key, 'last_refill_ms'))

if not tokens or not last_refill_ms then
  tokens = max_requests
  last_refill_ms = now_ms
end

if now_ms > last_refill_ms then
  local elapsed_ms = now_ms - last_refill_ms
  local refill_tokens = elapsed_ms * refill_rate
  tokens = math.min(max_requests, tokens + refill_tokens)
  last_refill_ms = now_ms
end

local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end

local remaining = math.floor(tokens)
if remaining < 0 then
  remaining = 0
end

local tokens_needed = math.max(0, 1 - tokens)
local retry_ms = tokens_needed / refill_rate
local reset_ms = (max_requests - tokens) / refill_rate
local retry_seconds = 0
if allowed == 0 then
  retry_seconds = math.max(1, math.ceil(retry_ms / 1000))
end
local reset_seconds = math.max(1, math.ceil(reset_ms / 1000))

redis.call('HSET', key,
  'tokens', tokens,
  'last_refill_ms', last_refill_ms,
  'last_seen_ms', now_ms
)
redis.call('PEXPIRE', key, max_idle_ms)

return { allowed, max_requests, remaining, reset_seconds, retry_seconds }
`;

export class RedisRateLimiter implements RateLimiterPort {
  private readonly windowMs: number;
  private readonly maxIdleMs: number;
  private readonly nowMs: () => number;

  constructor(
    private readonly redis: Redis,
    private readonly options: RedisRateLimiterOptions,
  ) {
    this.windowMs = options.windowSeconds * 1000;
    this.maxIdleMs = this.windowMs * (options.maxIdleWindows ?? 3);
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  async consume(identity: string): Promise<RateLimitDecision> {
    const key = `${this.options.keyPrefix}:${identity}`;
    const raw = (await this.redis.eval(
      TOKEN_BUCKET_LUA,
      1,
      key,
      this.nowMs(),
      this.windowMs,
      this.options.maxRequests,
      this.maxIdleMs,
    )) as Array<number | string>;

    const allowed = Number(raw[0]) === 1;
    const limit = Number(raw[1]);
    const remaining = Number(raw[2]);
    const resetSeconds = Number(raw[3]);
    const retryAfterSeconds = Number(raw[4]);

    return {
      allowed,
      limit,
      remaining,
      resetSeconds,
      retryAfterSeconds,
    };
  }
}
