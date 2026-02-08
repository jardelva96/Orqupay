import type { CreatePaymentIntentInput } from "../domain/types.js";

export type RiskDecision = "allow" | "review" | "deny";

export interface RiskAssessment {
  decision: RiskDecision;
  reason: string;
}

export interface RiskEnginePort {
  assessPayment(input: CreatePaymentIntentInput): Promise<RiskAssessment>;
}

