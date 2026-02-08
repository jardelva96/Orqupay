import { describe, expect, it } from "vitest";
import { ProviderRouter } from "../src/application/provider-router.js";
import type { PaymentMethodType } from "../src/domain/types.js";
import type { ClockPort } from "../src/infra/clock.js";
import type {
  AuthorizeInput,
  AuthorizeResult,
  CaptureInput,
  CaptureResult,
  ProviderGatewayPort,
  RefundInput,
  RefundResult,
} from "../src/ports/provider-gateway.js";

class MutableClock implements ClockPort {
  constructor(private now: string) {}

  nowIso(): string {
    return this.now;
  }

  setNow(nextNow: string): void {
    this.now = nextNow;
  }
}

class StubProvider implements ProviderGatewayPort {
  constructor(
    public readonly name: string,
    private readonly methods: PaymentMethodType[],
  ) {}

  supports(paymentMethod: PaymentMethodType): boolean {
    return this.methods.includes(paymentMethod);
  }

  async authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    void input;
    return { ok: true, reference: `${this.name}_auth` };
  }

  async capture(input: CaptureInput): Promise<CaptureResult> {
    void input;
    return { ok: true };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    void input;
    return { ok: true };
  }
}

describe("ProviderRouter circuit breaker", () => {
  it("opens transient provider circuit and skips provider", () => {
    const clock = new MutableClock("2026-02-08T10:00:00.000Z");
    const providerA = new StubProvider("provider_a", ["card"]);
    const providerB = new StubProvider("provider_b", ["card"]);
    const router = new ProviderRouter(
      [providerA, providerB],
      {
        defaultProvider: "provider_a",
        methodPriority: { card: ["provider_b", "provider_a"] },
      },
      {
        clock,
        circuitBreaker: {
          enabled: true,
          failureThreshold: 1,
          cooldownSeconds: 60,
          transientFailuresOnly: true,
        },
      },
    );

    router.recordAuthorizeOutcome("provider_b", {
      ok: false,
      reference: "provider_b_1",
      failureCode: "transient_network_error",
    });
    const candidates = router.selectCandidates("card");
    expect(candidates[0]?.name).toBe("provider_a");
    expect(candidates.some((provider) => provider.name === "provider_b")).toBe(false);
  });

  it("reopens provider after cooldown", () => {
    const clock = new MutableClock("2026-02-08T10:00:00.000Z");
    const providerA = new StubProvider("provider_a", ["card"]);
    const providerB = new StubProvider("provider_b", ["card"]);
    const router = new ProviderRouter(
      [providerA, providerB],
      {
        defaultProvider: "provider_a",
        methodPriority: { card: ["provider_b", "provider_a"] },
      },
      {
        clock,
        circuitBreaker: {
          enabled: true,
          failureThreshold: 1,
          cooldownSeconds: 60,
          transientFailuresOnly: true,
        },
      },
    );

    router.recordAuthorizeOutcome("provider_b", {
      ok: false,
      reference: "provider_b_1",
      failureCode: "provider_unavailable",
    });
    clock.setNow("2026-02-08T10:01:01.000Z");

    const candidates = router.selectCandidates("card");
    expect(candidates[0]?.name).toBe("provider_b");
  });

  it("does not open circuit for non-transient declines when transient-only is enabled", () => {
    const clock = new MutableClock("2026-02-08T10:00:00.000Z");
    const providerA = new StubProvider("provider_a", ["card"]);
    const providerB = new StubProvider("provider_b", ["card"]);
    const router = new ProviderRouter(
      [providerA, providerB],
      {
        defaultProvider: "provider_a",
        methodPriority: { card: ["provider_b", "provider_a"] },
      },
      {
        clock,
        circuitBreaker: {
          enabled: true,
          failureThreshold: 1,
          cooldownSeconds: 60,
          transientFailuresOnly: true,
        },
      },
    );

    router.recordAuthorizeOutcome("provider_b", {
      ok: false,
      reference: "provider_b_1",
      failureCode: "provider_declined",
    });
    const candidates = router.selectCandidates("card");
    expect(candidates[0]?.name).toBe("provider_b");
  });
});
