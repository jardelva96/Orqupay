import type { PaymentStatus } from "./types.js";
import { AppError } from "../infra/app-error.js";

const ALLOWED_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  requires_confirmation: ["processing", "canceled"],
  processing: ["requires_action", "succeeded", "failed"],
  requires_action: ["processing", "failed", "canceled"],
  succeeded: [],
  failed: [],
  canceled: [],
};

const TERMINAL_STATUSES: Set<PaymentStatus> = new Set(["succeeded", "failed", "canceled"]);

export function canTransition(current: PaymentStatus, next: PaymentStatus): boolean {
  const allowed = ALLOWED_TRANSITIONS[current];
  return allowed.includes(next);
}

export function isTerminalStatus(status: PaymentStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function assertTransition(current: PaymentStatus, next: PaymentStatus): void {
  if (canTransition(current, next)) {
    return;
  }
  throw new AppError(
    409,
    "invalid_state_transition",
    `Transition from '${current}' to '${next}' is not allowed.`,
  );
}
