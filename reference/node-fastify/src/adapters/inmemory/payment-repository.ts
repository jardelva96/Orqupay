import type { ChargebackRecord, LedgerEntryRecord, PaymentIntentRecord, RefundRecord } from "../../domain/types.js";
import type {
  ChargebackListInput,
  ChargebackListResult,
  LedgerEntryListInput,
  LedgerEntryListResult,
  PaymentIntentListInput,
  PaymentIntentListResult,
  PaymentRepositoryPort,
  RefundListInput,
  RefundListResult,
} from "../../ports/payment-repository.js";
import { AppError } from "../../infra/app-error.js";

export class InMemoryPaymentRepository implements PaymentRepositoryPort {
  private readonly paymentIntents = new Map<string, PaymentIntentRecord>();
  private readonly refunds = new Map<string, RefundRecord>();
  private readonly chargebacks = new Map<string, ChargebackRecord>();
  private readonly ledgerEntries = new Map<string, LedgerEntryRecord>();

  async savePaymentIntent(intent: PaymentIntentRecord): Promise<void> {
    this.paymentIntents.set(intent.id, intent);
  }

  async getPaymentIntentById(id: string): Promise<PaymentIntentRecord | null> {
    return this.paymentIntents.get(id) ?? null;
  }

  async listPaymentIntents(input: PaymentIntentListInput): Promise<PaymentIntentListResult> {
    const items = [...this.paymentIntents.values()]
      .filter((intent) => {
        if (input.amountMin !== undefined && intent.amount < input.amountMin) {
          return false;
        }
        if (input.amountMax !== undefined && intent.amount > input.amountMax) {
          return false;
        }
        if (input.currency && intent.currency !== input.currency) {
          return false;
        }
        if (input.status && intent.status !== input.status) {
          return false;
        }
        if (input.customerId && intent.customer_id !== input.customerId) {
          return false;
        }
        if (input.provider && intent.provider !== input.provider) {
          return false;
        }
        if (input.providerReference && intent.provider_reference !== input.providerReference) {
          return false;
        }
        if (input.paymentMethodType && intent.payment_method_type !== input.paymentMethodType) {
          return false;
        }
        if (input.createdFrom) {
          const createdFromMs = Date.parse(input.createdFrom);
          const intentCreatedAtMs = Date.parse(intent.created_at);
          if (Number.isFinite(createdFromMs) && Number.isFinite(intentCreatedAtMs) && intentCreatedAtMs < createdFromMs) {
            return false;
          }
        }
        if (input.createdTo) {
          const createdToMs = Date.parse(input.createdTo);
          const intentCreatedAtMs = Date.parse(intent.created_at);
          if (Number.isFinite(createdToMs) && Number.isFinite(intentCreatedAtMs) && intentCreatedAtMs > createdToMs) {
            return false;
          }
        }
        return true;
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return this.paginate(items, input);
  }

  async saveRefund(refund: RefundRecord): Promise<void> {
    this.refunds.set(refund.id, refund);
  }

  async listRefunds(input: RefundListInput): Promise<RefundListResult> {
    const items = [...this.refunds.values()]
      .filter((refund) => {
        if (input.amountMin !== undefined && refund.amount < input.amountMin) {
          return false;
        }
        if (input.amountMax !== undefined && refund.amount > input.amountMax) {
          return false;
        }
        if (input.status && refund.status !== input.status) {
          return false;
        }
        if (input.paymentIntentId && refund.payment_intent_id !== input.paymentIntentId) {
          return false;
        }
        if (input.createdFrom) {
          const createdFromMs = Date.parse(input.createdFrom);
          const refundCreatedAtMs = Date.parse(refund.created_at);
          if (Number.isFinite(createdFromMs) && Number.isFinite(refundCreatedAtMs) && refundCreatedAtMs < createdFromMs) {
            return false;
          }
        }
        if (input.createdTo) {
          const createdToMs = Date.parse(input.createdTo);
          const refundCreatedAtMs = Date.parse(refund.created_at);
          if (Number.isFinite(createdToMs) && Number.isFinite(refundCreatedAtMs) && refundCreatedAtMs > createdToMs) {
            return false;
          }
        }
        return true;
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return this.paginateRefunds(items, input);
  }

  async saveChargeback(chargeback: ChargebackRecord): Promise<void> {
    this.chargebacks.set(chargeback.id, chargeback);
  }

  async getChargebackById(id: string): Promise<ChargebackRecord | null> {
    return this.chargebacks.get(id) ?? null;
  }

  async listChargebacks(input: ChargebackListInput): Promise<ChargebackListResult> {
    const items = [...this.chargebacks.values()]
      .filter((chargeback) => {
        if (input.paymentIntentId && chargeback.payment_intent_id !== input.paymentIntentId) {
          return false;
        }
        if (input.status && chargeback.status !== input.status) {
          return false;
        }
        if (input.createdFrom) {
          const createdFromMs = Date.parse(input.createdFrom);
          const createdAtMs = Date.parse(chargeback.created_at);
          if (Number.isFinite(createdFromMs) && Number.isFinite(createdAtMs) && createdAtMs < createdFromMs) {
            return false;
          }
        }
        if (input.createdTo) {
          const createdToMs = Date.parse(input.createdTo);
          const createdAtMs = Date.parse(chargeback.created_at);
          if (Number.isFinite(createdToMs) && Number.isFinite(createdAtMs) && createdAtMs > createdToMs) {
            return false;
          }
        }
        return true;
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return this.paginateChargebacks(items, input);
  }

  async saveLedgerEntry(entry: LedgerEntryRecord): Promise<void> {
    this.ledgerEntries.set(entry.id, entry);
  }

  async listLedgerEntries(input: LedgerEntryListInput): Promise<LedgerEntryListResult> {
    const items = [...this.ledgerEntries.values()]
      .filter((entry) => {
        if (input.amountMin !== undefined && entry.amount < input.amountMin) {
          return false;
        }
        if (input.amountMax !== undefined && entry.amount > input.amountMax) {
          return false;
        }
        if (input.paymentIntentId && entry.payment_intent_id !== input.paymentIntentId) {
          return false;
        }
        if (input.refundId && entry.refund_id !== input.refundId) {
          return false;
        }
        if (input.entryType && entry.entry_type !== input.entryType) {
          return false;
        }
        if (input.direction && entry.direction !== input.direction) {
          return false;
        }
        if (input.currency && entry.currency !== input.currency) {
          return false;
        }
        if (input.createdFrom) {
          const createdFromMs = Date.parse(input.createdFrom);
          const createdAtMs = Date.parse(entry.created_at);
          if (Number.isFinite(createdFromMs) && Number.isFinite(createdAtMs) && createdAtMs < createdFromMs) {
            return false;
          }
        }
        if (input.createdTo) {
          const createdToMs = Date.parse(input.createdTo);
          const createdAtMs = Date.parse(entry.created_at);
          if (Number.isFinite(createdToMs) && Number.isFinite(createdAtMs) && createdAtMs > createdToMs) {
            return false;
          }
        }
        return true;
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return this.paginateLedgerEntries(items, input);
  }

  private paginate(items: PaymentIntentRecord[], input: PaymentIntentListInput): PaymentIntentListResult {
    const limit = Math.max(1, input.limit);
    let startIndex = 0;

    if (input.cursor) {
      const cursorIndex = items.findIndex((item) => item.id === input.cursor);
      if (cursorIndex < 0) {
        throw new AppError(422, "invalid_cursor", "cursor not found for current collection.");
      }
      startIndex = cursorIndex + 1;
    }

    const page = items.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + page.length < items.length;
    const lastItem = page.at(-1);
    const nextCursor = hasMore && lastItem ? lastItem.id : undefined;

    return {
      data: page,
      hasMore,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  private paginateRefunds(items: RefundRecord[], input: RefundListInput): RefundListResult {
    const limit = Math.max(1, input.limit);
    let startIndex = 0;

    if (input.cursor) {
      const cursorIndex = items.findIndex((item) => item.id === input.cursor);
      if (cursorIndex < 0) {
        throw new AppError(422, "invalid_cursor", "cursor not found for current collection.");
      }
      startIndex = cursorIndex + 1;
    }

    const page = items.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + page.length < items.length;
    const lastItem = page.at(-1);
    const nextCursor = hasMore && lastItem ? lastItem.id : undefined;

    return {
      data: page,
      hasMore,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  private paginateChargebacks(items: ChargebackRecord[], input: ChargebackListInput): ChargebackListResult {
    const limit = Math.max(1, input.limit);
    let startIndex = 0;

    if (input.cursor) {
      const cursorIndex = items.findIndex((item) => item.id === input.cursor);
      if (cursorIndex < 0) {
        throw new AppError(422, "invalid_cursor", "cursor not found for current collection.");
      }
      startIndex = cursorIndex + 1;
    }

    const page = items.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + page.length < items.length;
    const lastItem = page.at(-1);
    const nextCursor = hasMore && lastItem ? lastItem.id : undefined;

    return {
      data: page,
      hasMore,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  private paginateLedgerEntries(items: LedgerEntryRecord[], input: LedgerEntryListInput): LedgerEntryListResult {
    const limit = Math.max(1, input.limit);
    let startIndex = 0;

    if (input.cursor) {
      const cursorIndex = items.findIndex((item) => item.id === input.cursor);
      if (cursorIndex < 0) {
        throw new AppError(422, "invalid_cursor", "cursor not found for current collection.");
      }
      startIndex = cursorIndex + 1;
    }

    const page = items.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + page.length < items.length;
    const lastItem = page.at(-1);
    const nextCursor = hasMore && lastItem ? lastItem.id : undefined;

    return {
      data: page,
      hasMore,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }
}
