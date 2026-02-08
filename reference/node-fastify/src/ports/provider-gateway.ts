import type { PaymentMethodType } from "../domain/types.js";

export interface AuthorizeInput {
  amount: number;
  currency: string;
  paymentMethodType: PaymentMethodType;
  paymentMethodToken: string;
}

export interface AuthorizeResult {
  ok: boolean;
  reference: string;
  failureCode?: string;
}

export interface CaptureInput {
  amount: number;
  reference: string;
}

export interface CaptureResult {
  ok: boolean;
  failureCode?: string;
}

export interface RefundInput {
  amount: number;
  reference: string;
}

export interface RefundResult {
  ok: boolean;
  failureCode?: string;
}

export interface ProviderGatewayPort {
  readonly name: string;
  supports(paymentMethod: PaymentMethodType): boolean;
  authorize(input: AuthorizeInput): Promise<AuthorizeResult>;
  capture(input: CaptureInput): Promise<CaptureResult>;
  refund(input: RefundInput): Promise<RefundResult>;
}

