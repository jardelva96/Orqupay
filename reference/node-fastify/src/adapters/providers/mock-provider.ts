import { randomUUID } from "node:crypto";
import type {
  AuthorizeInput,
  AuthorizeResult,
  CaptureInput,
  CaptureResult,
  ProviderGatewayPort,
  RefundInput,
  RefundResult,
} from "../../ports/provider-gateway.js";
import type { PaymentMethodType } from "../../domain/types.js";

interface MockProviderOptions {
  name: string;
  supportedMethods: PaymentMethodType[];
}

export class MockProviderGateway implements ProviderGatewayPort {
  public readonly name: string;
  private readonly supportedMethods: Set<PaymentMethodType>;

  constructor(options: MockProviderOptions) {
    this.name = options.name;
    this.supportedMethods = new Set(options.supportedMethods);
  }

  supports(paymentMethod: PaymentMethodType): boolean {
    return this.supportedMethods.has(paymentMethod);
  }

  async authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    if (input.paymentMethodToken.includes("tok_test_transient") && this.name === "provider_b") {
      return {
        ok: false,
        reference: `${this.name}_${randomUUID()}`,
        failureCode: "transient_network_error",
      };
    }

    if (input.paymentMethodToken.includes("tok_test_unavailable")) {
      return { ok: false, reference: `${this.name}_${randomUUID()}`, failureCode: "provider_unavailable" };
    }

    if (input.paymentMethodToken.includes("tok_test_fail")) {
      return { ok: false, reference: `${this.name}_${randomUUID()}`, failureCode: "provider_declined" };
    }

    if (input.paymentMethodToken.includes("tok_test_refund_fail")) {
      return { ok: true, reference: `${this.name}_refund_fail_${randomUUID()}` };
    }

    return { ok: true, reference: `${this.name}_${randomUUID()}` };
  }

  async capture(input: CaptureInput): Promise<CaptureResult> {
    if (input.reference.includes("capture_fail")) {
      return { ok: false, failureCode: "capture_rejected" };
    }
    return { ok: true };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    if (input.reference.includes("refund_fail")) {
      return { ok: false, failureCode: "refund_rejected" };
    }
    return { ok: true };
  }
}
