import type { RateLimitDecision } from "../infra/rate-limiter.js";

export interface RateLimiterPort {
  consume(identity: string): Promise<RateLimitDecision> | RateLimitDecision;
}
