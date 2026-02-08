import type {
  ChargebackRecord,
  ChargebackStatus,
  LedgerEntryDirection,
  LedgerEntryRecord,
  LedgerEntryType,
  PaymentMethodType,
  PaymentIntentRecord,
  PaymentStatus,
  RefundRecord,
  RefundStatus,
} from "../domain/types.js";

export interface PaymentIntentListInput {
  limit: number;
  cursor?: string;
  amountMin?: number;
  amountMax?: number;
  currency?: string;
  status?: PaymentStatus;
  customerId?: string;
  provider?: string;
  providerReference?: string;
  paymentMethodType?: PaymentMethodType;
  createdFrom?: string;
  createdTo?: string;
}

export interface PaymentIntentListResult {
  data: PaymentIntentRecord[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface RefundListInput {
  limit: number;
  cursor?: string;
  amountMin?: number;
  amountMax?: number;
  paymentIntentId?: string;
  status?: RefundStatus;
  createdFrom?: string;
  createdTo?: string;
}

export interface RefundListResult {
  data: RefundRecord[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface LedgerEntryListInput {
  limit: number;
  cursor?: string;
  amountMin?: number;
  amountMax?: number;
  paymentIntentId?: string;
  refundId?: string;
  entryType?: LedgerEntryType;
  direction?: LedgerEntryDirection;
  currency?: string;
  createdFrom?: string;
  createdTo?: string;
}

export interface LedgerEntryListResult {
  data: LedgerEntryRecord[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface ChargebackListInput {
  limit: number;
  cursor?: string;
  paymentIntentId?: string;
  status?: ChargebackStatus;
  createdFrom?: string;
  createdTo?: string;
}

export interface ChargebackListResult {
  data: ChargebackRecord[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface PaymentRepositoryPort {
  savePaymentIntent(intent: PaymentIntentRecord): Promise<void>;
  getPaymentIntentById(id: string): Promise<PaymentIntentRecord | null>;
  listPaymentIntents(input: PaymentIntentListInput): Promise<PaymentIntentListResult>;
  saveRefund(refund: RefundRecord): Promise<void>;
  listRefunds(input: RefundListInput): Promise<RefundListResult>;
  saveChargeback(chargeback: ChargebackRecord): Promise<void>;
  getChargebackById(id: string): Promise<ChargebackRecord | null>;
  listChargebacks(input: ChargebackListInput): Promise<ChargebackListResult>;
  saveLedgerEntry(entry: LedgerEntryRecord): Promise<void>;
  listLedgerEntries(input: LedgerEntryListInput): Promise<LedgerEntryListResult>;
}
