import type { CreatePaymentIntentInput } from "../../domain/types.js";
import type { RiskAssessment, RiskEnginePort } from "../../ports/risk-engine.js";

interface InMemoryRiskEngineOptions {
  reviewAmountThreshold: number;
}

export class InMemoryRiskEngine implements RiskEnginePort {
  constructor(private readonly options: InMemoryRiskEngineOptions) {}

  async assessPayment(input: CreatePaymentIntentInput): Promise<RiskAssessment> {
    if (input.customer.id.startsWith("blocked_")) {
      return { decision: "deny", reason: "blocked_customer" };
    }

    if (input.amount >= this.options.reviewAmountThreshold) {
      return { decision: "review", reason: "high_amount_review" };
    }

    return { decision: "allow", reason: "rule_engine_default_allow" };
  }
}

