import type { Pool } from "pg";
import type {
  ChargebackRecord,
  LedgerEntryRecord,
  PaymentIntentRecord,
  RefundRecord,
} from "../../domain/types.js";
import { AppError } from "../../infra/app-error.js";
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

type CursorInput = { cursor?: string; limit: number };

function mapTimestamp(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function toNumber(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new AppError(500, "persistence_mapping_error", `Unable to map numeric field '${field}'.`);
  }
  return parsed;
}

function paginateByCursor<TItem extends { id: string }>(
  items: TItem[],
  input: CursorInput,
): { data: TItem[]; hasMore: boolean; nextCursor?: string } {
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
  const nextCursor = hasMore ? page.at(-1)?.id : undefined;

  return {
    data: page,
    hasMore,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

export class PostgresPaymentRepository implements PaymentRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async savePaymentIntent(intent: PaymentIntentRecord): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO pmc_payment_intents (
          id,
          amount,
          currency,
          status,
          capture_method,
          customer_id,
          payment_method_type,
          payment_method_token,
          authorized_amount,
          captured_amount,
          refunded_amount,
          provider,
          provider_reference,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2::bigint,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9::bigint,
          $10::bigint,
          $11::bigint,
          $12,
          $13,
          $14::timestamptz,
          $15::timestamptz
        )
        ON CONFLICT (id) DO UPDATE
        SET amount = EXCLUDED.amount,
            currency = EXCLUDED.currency,
            status = EXCLUDED.status,
            capture_method = EXCLUDED.capture_method,
            customer_id = EXCLUDED.customer_id,
            payment_method_type = EXCLUDED.payment_method_type,
            payment_method_token = EXCLUDED.payment_method_token,
            authorized_amount = EXCLUDED.authorized_amount,
            captured_amount = EXCLUDED.captured_amount,
            refunded_amount = EXCLUDED.refunded_amount,
            provider = EXCLUDED.provider,
            provider_reference = EXCLUDED.provider_reference,
            updated_at = EXCLUDED.updated_at
      `,
      [
        intent.id,
        intent.amount,
        intent.currency,
        intent.status,
        intent.capture_method,
        intent.customer_id,
        intent.payment_method_type,
        intent.payment_method_token,
        intent.authorized_amount,
        intent.captured_amount,
        intent.refunded_amount,
        intent.provider,
        intent.provider_reference,
        intent.created_at,
        intent.updated_at,
      ],
    );
  }

  async getPaymentIntentById(id: string): Promise<PaymentIntentRecord | null> {
    const result = await this.pool.query<{
      id: string;
      amount: unknown;
      currency: string;
      status: PaymentIntentRecord["status"];
      capture_method: PaymentIntentRecord["capture_method"];
      customer_id: string;
      payment_method_type: PaymentIntentRecord["payment_method_type"];
      payment_method_token: string;
      authorized_amount: unknown;
      captured_amount: unknown;
      refunded_amount: unknown;
      provider: string | null;
      provider_reference: string | null;
      created_at: unknown;
      updated_at: unknown;
    }>(
      `
        SELECT
          id,
          amount,
          currency,
          status,
          capture_method,
          customer_id,
          payment_method_type,
          payment_method_token,
          authorized_amount,
          captured_amount,
          refunded_amount,
          provider,
          provider_reference,
          created_at,
          updated_at
        FROM pmc_payment_intents
        WHERE id = $1
      `,
      [id],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      amount: toNumber(row.amount, "amount"),
      currency: row.currency,
      status: row.status,
      capture_method: row.capture_method,
      customer_id: row.customer_id,
      payment_method_type: row.payment_method_type,
      payment_method_token: row.payment_method_token,
      authorized_amount: toNumber(row.authorized_amount, "authorized_amount"),
      captured_amount: toNumber(row.captured_amount, "captured_amount"),
      refunded_amount: toNumber(row.refunded_amount, "refunded_amount"),
      provider: row.provider,
      provider_reference: row.provider_reference,
      created_at: mapTimestamp(row.created_at),
      updated_at: mapTimestamp(row.updated_at),
    };
  }

  async listPaymentIntents(input: PaymentIntentListInput): Promise<PaymentIntentListResult> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let index = 1;

    if (input.amountMin !== undefined) {
      conditions.push(`amount >= $${index}::bigint`);
      values.push(input.amountMin);
      index += 1;
    }
    if (input.amountMax !== undefined) {
      conditions.push(`amount <= $${index}::bigint`);
      values.push(input.amountMax);
      index += 1;
    }
    if (input.currency) {
      conditions.push(`currency = $${index}`);
      values.push(input.currency);
      index += 1;
    }
    if (input.status) {
      conditions.push(`status = $${index}`);
      values.push(input.status);
      index += 1;
    }
    if (input.customerId) {
      conditions.push(`customer_id = $${index}`);
      values.push(input.customerId);
      index += 1;
    }
    if (input.provider) {
      conditions.push(`provider = $${index}`);
      values.push(input.provider);
      index += 1;
    }
    if (input.providerReference) {
      conditions.push(`provider_reference = $${index}`);
      values.push(input.providerReference);
      index += 1;
    }
    if (input.paymentMethodType) {
      conditions.push(`payment_method_type = $${index}`);
      values.push(input.paymentMethodType);
      index += 1;
    }
    if (input.createdFrom) {
      conditions.push(`created_at >= $${index}::timestamptz`);
      values.push(input.createdFrom);
      index += 1;
    }
    if (input.createdTo) {
      conditions.push(`created_at <= $${index}::timestamptz`);
      values.push(input.createdTo);
      index += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query<{
      id: string;
      amount: unknown;
      currency: string;
      status: PaymentIntentRecord["status"];
      capture_method: PaymentIntentRecord["capture_method"];
      customer_id: string;
      payment_method_type: PaymentIntentRecord["payment_method_type"];
      payment_method_token: string;
      authorized_amount: unknown;
      captured_amount: unknown;
      refunded_amount: unknown;
      provider: string | null;
      provider_reference: string | null;
      created_at: unknown;
      updated_at: unknown;
    }>(
      `
        SELECT
          id,
          amount,
          currency,
          status,
          capture_method,
          customer_id,
          payment_method_type,
          payment_method_token,
          authorized_amount,
          captured_amount,
          refunded_amount,
          provider,
          provider_reference,
          created_at,
          updated_at
        FROM pmc_payment_intents
        ${whereClause}
        ORDER BY created_at DESC, id DESC
      `,
      values,
    );

    const items = result.rows.map((row) => ({
      id: row.id,
      amount: toNumber(row.amount, "amount"),
      currency: row.currency,
      status: row.status,
      capture_method: row.capture_method,
      customer_id: row.customer_id,
      payment_method_type: row.payment_method_type,
      payment_method_token: row.payment_method_token,
      authorized_amount: toNumber(row.authorized_amount, "authorized_amount"),
      captured_amount: toNumber(row.captured_amount, "captured_amount"),
      refunded_amount: toNumber(row.refunded_amount, "refunded_amount"),
      provider: row.provider,
      provider_reference: row.provider_reference,
      created_at: mapTimestamp(row.created_at),
      updated_at: mapTimestamp(row.updated_at),
    }));
    return paginateByCursor(items, input);
  }

  async saveRefund(refund: RefundRecord): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO pmc_refunds (
          id,
          payment_intent_id,
          amount,
          status,
          reason,
          created_at
        )
        VALUES (
          $1,
          $2,
          $3::bigint,
          $4,
          $5,
          $6::timestamptz
        )
        ON CONFLICT (id) DO UPDATE
        SET payment_intent_id = EXCLUDED.payment_intent_id,
            amount = EXCLUDED.amount,
            status = EXCLUDED.status,
            reason = EXCLUDED.reason
      `,
      [refund.id, refund.payment_intent_id, refund.amount, refund.status, refund.reason ?? null, refund.created_at],
    );
  }

  async listRefunds(input: RefundListInput): Promise<RefundListResult> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let index = 1;

    if (input.amountMin !== undefined) {
      conditions.push(`amount >= $${index}::bigint`);
      values.push(input.amountMin);
      index += 1;
    }
    if (input.amountMax !== undefined) {
      conditions.push(`amount <= $${index}::bigint`);
      values.push(input.amountMax);
      index += 1;
    }
    if (input.status) {
      conditions.push(`status = $${index}`);
      values.push(input.status);
      index += 1;
    }
    if (input.paymentIntentId) {
      conditions.push(`payment_intent_id = $${index}`);
      values.push(input.paymentIntentId);
      index += 1;
    }
    if (input.createdFrom) {
      conditions.push(`created_at >= $${index}::timestamptz`);
      values.push(input.createdFrom);
      index += 1;
    }
    if (input.createdTo) {
      conditions.push(`created_at <= $${index}::timestamptz`);
      values.push(input.createdTo);
      index += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query<{
      id: string;
      payment_intent_id: string;
      amount: unknown;
      status: RefundRecord["status"];
      reason: RefundRecord["reason"];
      created_at: unknown;
    }>(
      `
        SELECT
          id,
          payment_intent_id,
          amount,
          status,
          reason,
          created_at
        FROM pmc_refunds
        ${whereClause}
        ORDER BY created_at DESC, id DESC
      `,
      values,
    );

    const items = result.rows.map((row) => ({
      id: row.id,
      payment_intent_id: row.payment_intent_id,
      amount: toNumber(row.amount, "amount"),
      status: row.status,
      ...(row.reason ? { reason: row.reason } : {}),
      created_at: mapTimestamp(row.created_at),
    }));
    return paginateByCursor(items, input);
  }

  async saveChargeback(chargeback: ChargebackRecord): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO pmc_chargebacks (
          id,
          payment_intent_id,
          amount,
          reason,
          status,
          evidence_url,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3::bigint,
          $4,
          $5,
          $6,
          $7::timestamptz,
          $8::timestamptz
        )
        ON CONFLICT (id) DO UPDATE
        SET payment_intent_id = EXCLUDED.payment_intent_id,
            amount = EXCLUDED.amount,
            reason = EXCLUDED.reason,
            status = EXCLUDED.status,
            evidence_url = EXCLUDED.evidence_url,
            updated_at = EXCLUDED.updated_at
      `,
      [
        chargeback.id,
        chargeback.payment_intent_id,
        chargeback.amount,
        chargeback.reason,
        chargeback.status,
        chargeback.evidence_url ?? null,
        chargeback.created_at,
        chargeback.updated_at,
      ],
    );
  }

  async getChargebackById(id: string): Promise<ChargebackRecord | null> {
    const result = await this.pool.query<{
      id: string;
      payment_intent_id: string;
      amount: unknown;
      reason: ChargebackRecord["reason"];
      status: ChargebackRecord["status"];
      evidence_url: string | null;
      created_at: unknown;
      updated_at: unknown;
    }>(
      `
        SELECT
          id,
          payment_intent_id,
          amount,
          reason,
          status,
          evidence_url,
          created_at,
          updated_at
        FROM pmc_chargebacks
        WHERE id = $1
      `,
      [id],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      payment_intent_id: row.payment_intent_id,
      amount: toNumber(row.amount, "amount"),
      reason: row.reason,
      status: row.status,
      ...(row.evidence_url ? { evidence_url: row.evidence_url } : {}),
      created_at: mapTimestamp(row.created_at),
      updated_at: mapTimestamp(row.updated_at),
    };
  }

  async listChargebacks(input: ChargebackListInput): Promise<ChargebackListResult> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let index = 1;

    if (input.paymentIntentId) {
      conditions.push(`payment_intent_id = $${index}`);
      values.push(input.paymentIntentId);
      index += 1;
    }
    if (input.status) {
      conditions.push(`status = $${index}`);
      values.push(input.status);
      index += 1;
    }
    if (input.createdFrom) {
      conditions.push(`created_at >= $${index}::timestamptz`);
      values.push(input.createdFrom);
      index += 1;
    }
    if (input.createdTo) {
      conditions.push(`created_at <= $${index}::timestamptz`);
      values.push(input.createdTo);
      index += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query<{
      id: string;
      payment_intent_id: string;
      amount: unknown;
      reason: ChargebackRecord["reason"];
      status: ChargebackRecord["status"];
      evidence_url: string | null;
      created_at: unknown;
      updated_at: unknown;
    }>(
      `
        SELECT
          id,
          payment_intent_id,
          amount,
          reason,
          status,
          evidence_url,
          created_at,
          updated_at
        FROM pmc_chargebacks
        ${whereClause}
        ORDER BY created_at DESC, id DESC
      `,
      values,
    );

    const items = result.rows.map((row) => ({
      id: row.id,
      payment_intent_id: row.payment_intent_id,
      amount: toNumber(row.amount, "amount"),
      reason: row.reason,
      status: row.status,
      ...(row.evidence_url ? { evidence_url: row.evidence_url } : {}),
      created_at: mapTimestamp(row.created_at),
      updated_at: mapTimestamp(row.updated_at),
    }));
    return paginateByCursor(items, input);
  }

  async saveLedgerEntry(entry: LedgerEntryRecord): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO pmc_ledger_entries (
          id,
          payment_intent_id,
          refund_id,
          entry_type,
          direction,
          amount,
          currency,
          provider,
          provider_reference,
          created_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6::bigint,
          $7,
          $8,
          $9,
          $10::timestamptz
        )
        ON CONFLICT (id) DO NOTHING
      `,
      [
        entry.id,
        entry.payment_intent_id,
        entry.refund_id,
        entry.entry_type,
        entry.direction,
        entry.amount,
        entry.currency,
        entry.provider,
        entry.provider_reference,
        entry.created_at,
      ],
    );
  }

  async listLedgerEntries(input: LedgerEntryListInput): Promise<LedgerEntryListResult> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let index = 1;

    if (input.amountMin !== undefined) {
      conditions.push(`amount >= $${index}::bigint`);
      values.push(input.amountMin);
      index += 1;
    }
    if (input.amountMax !== undefined) {
      conditions.push(`amount <= $${index}::bigint`);
      values.push(input.amountMax);
      index += 1;
    }
    if (input.paymentIntentId) {
      conditions.push(`payment_intent_id = $${index}`);
      values.push(input.paymentIntentId);
      index += 1;
    }
    if (input.refundId) {
      conditions.push(`refund_id = $${index}`);
      values.push(input.refundId);
      index += 1;
    }
    if (input.entryType) {
      conditions.push(`entry_type = $${index}`);
      values.push(input.entryType);
      index += 1;
    }
    if (input.direction) {
      conditions.push(`direction = $${index}`);
      values.push(input.direction);
      index += 1;
    }
    if (input.currency) {
      conditions.push(`currency = $${index}`);
      values.push(input.currency);
      index += 1;
    }
    if (input.createdFrom) {
      conditions.push(`created_at >= $${index}::timestamptz`);
      values.push(input.createdFrom);
      index += 1;
    }
    if (input.createdTo) {
      conditions.push(`created_at <= $${index}::timestamptz`);
      values.push(input.createdTo);
      index += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query<{
      id: string;
      payment_intent_id: string;
      refund_id: string | null;
      entry_type: LedgerEntryRecord["entry_type"];
      direction: LedgerEntryRecord["direction"];
      amount: unknown;
      currency: string;
      provider: string | null;
      provider_reference: string | null;
      created_at: unknown;
    }>(
      `
        SELECT
          id,
          payment_intent_id,
          refund_id,
          entry_type,
          direction,
          amount,
          currency,
          provider,
          provider_reference,
          created_at
        FROM pmc_ledger_entries
        ${whereClause}
        ORDER BY created_at DESC, id DESC
      `,
      values,
    );

    const items = result.rows.map((row) => ({
      id: row.id,
      payment_intent_id: row.payment_intent_id,
      refund_id: row.refund_id,
      entry_type: row.entry_type,
      direction: row.direction,
      amount: toNumber(row.amount, "amount"),
      currency: row.currency,
      provider: row.provider,
      provider_reference: row.provider_reference,
      created_at: mapTimestamp(row.created_at),
    }));
    return paginateByCursor(items, input);
  }
}
