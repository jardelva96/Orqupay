import { AppError } from "../infra/app-error.js";
import type { PaymentMethodType } from "../domain/types.js";
import type { AuthorizeResult, ProviderGatewayPort } from "../ports/provider-gateway.js";
import type { ClockPort } from "../infra/clock.js";

export interface RoutingPolicy {
  defaultProvider: string;
  methodPriority: Partial<Record<PaymentMethodType, string[]>>;
}

export interface CircuitBreakerPolicy {
  enabled: boolean;
  failureThreshold: number;
  cooldownSeconds: number;
  transientFailuresOnly: boolean;
}

interface ProviderRouterOptions {
  circuitBreaker?: Partial<CircuitBreakerPolicy>;
  clock?: ClockPort;
}

interface ProviderCircuitState {
  consecutiveFailures: number;
  openedUntilMs?: number;
}

const defaultClock: ClockPort = {
  nowIso() {
    return new Date().toISOString();
  },
};
const transientFailureCodes = new Set(["provider_unavailable", "transient_network_error", "timeout"]);

export class ProviderRouter {
  private readonly clock: ClockPort;
  private readonly circuitBreaker: CircuitBreakerPolicy;
  private readonly circuits = new Map<string, ProviderCircuitState>();

  constructor(
    private readonly providers: ProviderGatewayPort[],
    private readonly policy: RoutingPolicy,
    options: ProviderRouterOptions = {},
  ) {
    this.clock = options.clock ?? defaultClock;
    this.circuitBreaker = {
      enabled: true,
      failureThreshold: 3,
      cooldownSeconds: 30,
      transientFailuresOnly: true,
      ...(options.circuitBreaker ?? {}),
    };
  }

  select(paymentMethodType: PaymentMethodType): ProviderGatewayPort {
    const [primary] = this.selectCandidates(paymentMethodType);
    if (!primary) {
      throw new AppError(422, "provider_not_available", `No provider available for '${paymentMethodType}'.`);
    }
    return primary;
  }

  selectCandidates(paymentMethodType: PaymentMethodType): ProviderGatewayPort[] {
    const prioritizedNames = this.policy.methodPriority[paymentMethodType] ?? [this.policy.defaultProvider];
    const ordered: ProviderGatewayPort[] = [];
    const visited = new Set<string>();

    for (const name of prioritizedNames) {
      const provider = this.providers.find((item) => item.name === name);
      if (provider && provider.supports(paymentMethodType)) {
        ordered.push(provider);
        visited.add(provider.name);
      }
    }

    const fallback = this.providers.find(
      (item) => item.name === this.policy.defaultProvider && item.supports(paymentMethodType),
    );

    if (fallback && !visited.has(fallback.name)) {
      ordered.push(fallback);
    }

    if (ordered.length === 0) {
      throw new AppError(422, "provider_not_available", `No provider available for '${paymentMethodType}'.`);
    }

    const available = ordered.filter((provider) => !this.isProviderCircuitOpen(provider.name));
    if (available.length > 0) {
      return available;
    }

    throw new AppError(
      503,
      "provider_circuit_open",
      `All providers for '${paymentMethodType}' are temporarily unavailable.`,
    );
  }

  findByName(name: string): ProviderGatewayPort {
    const provider = this.providers.find((item) => item.name === name);
    if (provider) {
      return provider;
    }
    throw new AppError(422, "provider_not_available", `Provider '${name}' is not configured.`);
  }

  recordAuthorizeOutcome(providerName: string, result: AuthorizeResult): void {
    if (!this.circuitBreaker.enabled) {
      return;
    }
    const state = this.circuits.get(providerName) ?? { consecutiveFailures: 0 };

    if (result.ok) {
      this.circuits.delete(providerName);
      return;
    }

    if (this.circuitBreaker.transientFailuresOnly && !transientFailureCodes.has(result.failureCode ?? "")) {
      this.circuits.delete(providerName);
      return;
    }

    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= this.circuitBreaker.failureThreshold) {
      const now = Date.parse(this.clock.nowIso());
      state.openedUntilMs = now + this.circuitBreaker.cooldownSeconds * 1000;
      state.consecutiveFailures = 0;
    }
    this.circuits.set(providerName, state);
  }

  private isProviderCircuitOpen(providerName: string): boolean {
    if (!this.circuitBreaker.enabled) {
      return false;
    }
    const state = this.circuits.get(providerName);
    if (!state?.openedUntilMs) {
      return false;
    }

    const now = Date.parse(this.clock.nowIso());
    if (Number.isFinite(now) && now >= state.openedUntilMs) {
      this.circuits.delete(providerName);
      return false;
    }
    return true;
  }
}
