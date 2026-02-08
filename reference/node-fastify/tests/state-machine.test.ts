import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, isTerminalStatus } from "../src/domain/state-machine.js";
import { AppError } from "../src/infra/app-error.js";

describe("Payment state machine", () => {
  it("allows valid transitions", () => {
    expect(canTransition("requires_confirmation", "processing")).toBe(true);
    expect(canTransition("processing", "succeeded")).toBe(true);
    expect(canTransition("processing", "requires_action")).toBe(true);
    expect(canTransition("requires_confirmation", "canceled")).toBe(true);
    expect(canTransition("requires_action", "canceled")).toBe(true);
  });

  it("blocks invalid transitions", () => {
    expect(canTransition("requires_confirmation", "succeeded")).toBe(false);
    expect(() => assertTransition("requires_confirmation", "succeeded")).toThrowError(AppError);
  });

  it("marks terminal statuses", () => {
    expect(isTerminalStatus("succeeded")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("canceled")).toBe(true);
    expect(isTerminalStatus("processing")).toBe(false);
  });
});
