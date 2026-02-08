import { randomUUID } from "node:crypto";
import { assertTransition, isTerminalStatus } from "../domain/state-machine.js";
import type {
  ChargebackRecord,
  ChargebackResponse,
  CreateChargebackInput,
  CreatePaymentIntentInput,
  CreateRefundInput,
  LedgerEntryRecord,
  LedgerEntryResponse,
  PaymentEvent,
  PaymentIntentRecord,
  PaymentIntentResponse,
  RefundRecord,
  RefundResponse,
} from "../domain/types.js";
import { AppError } from "../infra/app-error.js";
import { fingerprintPayload } from "../infra/fingerprint.js";
import type { ClockPort } from "../infra/clock.js";
import type { EventBusPort } from "../ports/event-bus.js";
import type { IdempotencyStorePort } from "../ports/idempotency-store.js";
import type {
  ChargebackListInput,
  LedgerEntryListInput,
  PaymentIntentListInput,
  PaymentRepositoryPort,
  RefundListInput,
} from "../ports/payment-repository.js";
import type { RiskEnginePort } from "../ports/risk-engine.js";
import type { ProviderRouter } from "./provider-router.js";

interface IdempotentResult<TBody> {
  statusCode: number;
  body: TBody;
  idempotencyReplayed: boolean;
}

const TRANSIENT_PROVIDER_FAILURES = new Set(["provider_unavailable", "transient_network_error", "timeout"]);

function isTransientProviderFailure(code: string | undefined): boolean {
  if (!code) {
    return false;
  }
  return TRANSIENT_PROVIDER_FAILURES.has(code);
}

export class PaymentOrchestrator {
  constructor(
    private readonly repository: PaymentRepositoryPort,
    private readonly idempotencyStore: IdempotencyStorePort,
    private readonly eventBus: EventBusPort,
    private readonly providerRouter: ProviderRouter,
    private readonly riskEngine: RiskEnginePort,
    private readonly clock: ClockPort,
    private readonly eventApiVersion: string,
    private readonly eventSource: string,
    private readonly eventSchemaVersion: string,
  ) {}

  async createPaymentIntent(
    input: CreatePaymentIntentInput,
    idempotencyKey: string,
  ): Promise<IdempotentResult<PaymentIntentResponse>> {
    const idempotencyScope = "create_payment_intent";
    const payloadFingerprint = fingerprintPayload(input);
    return this.executeIdempotent(idempotencyScope, idempotencyKey, payloadFingerprint, async () => {
      const timestamp = this.clock.nowIso();
      const intent: PaymentIntentRecord = {
        id: `pi_${randomUUID()}`,
        amount: input.amount,
        currency: input.currency.toUpperCase(),
        status: "requires_confirmation",
        capture_method: input.capture_method,
        customer_id: input.customer.id,
        payment_method_type: input.payment_method.type,
        payment_method_token: input.payment_method.token,
        authorized_amount: 0,
        captured_amount: 0,
        refunded_amount: 0,
        provider: null,
        provider_reference: null,
        created_at: timestamp,
        updated_at: timestamp,
      };

      await this.repository.savePaymentIntent(intent);
      await this.publishEvent("payment_intent.created", {
        payment_intent_id: intent.id,
        amount: intent.amount,
        currency: intent.currency,
      });

      return {
        statusCode: 201,
        body: this.mapPaymentIntent(intent),
      };
    });
  }

  async getPaymentIntentById(id: string): Promise<PaymentIntentResponse> {
    const intent = await this.repository.getPaymentIntentById(id);
    if (!intent) {
      throw new AppError(404, "resource_not_found", `Payment intent '${id}' not found.`);
    }
    return this.mapPaymentIntent(intent);
  }

  async listPaymentIntents(input: PaymentIntentListInput): Promise<{
    data: PaymentIntentResponse[];
    hasMore: boolean;
    nextCursor?: string;
  }> {
    const page = await this.repository.listPaymentIntents(input);
    return {
      data: page.data.map((intent) => this.mapPaymentIntent(intent)),
      hasMore: page.hasMore,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  async confirmPaymentIntent(
    id: string,
    idempotencyKey: string,
  ): Promise<IdempotentResult<PaymentIntentResponse>> {
    const idempotencyScope = `confirm_payment_intent:${id}`;
    const payloadFingerprint = fingerprintPayload({ payment_intent_id: id });
    return this.executeIdempotent(idempotencyScope, idempotencyKey, payloadFingerprint, async () => {
      const intent = await this.getPaymentIntentRecordOrThrow(id);

      if (intent.status !== "requires_confirmation") {
        return { statusCode: 200, body: this.mapPaymentIntent(intent) };
      }

      assertTransition(intent.status, "processing");
      intent.status = "processing";
      intent.updated_at = this.clock.nowIso();
      await this.repository.savePaymentIntent(intent);
      await this.publishEvent("payment_intent.processing", { payment_intent_id: intent.id });

      const riskAssessment = await this.riskEngine.assessPayment({
        amount: intent.amount,
        currency: intent.currency,
        customer: { id: intent.customer_id },
        payment_method: {
          type: intent.payment_method_type,
          token: intent.payment_method_token,
        },
        capture_method: intent.capture_method,
      });

      if (riskAssessment.decision === "deny") {
        assertTransition(intent.status, "failed");
        intent.status = "failed";
        intent.updated_at = this.clock.nowIso();
        await this.repository.savePaymentIntent(intent);
        await this.publishEvent("payment_intent.failed", {
          payment_intent_id: intent.id,
          failure_code: "risk_denied",
          risk_reason: riskAssessment.reason,
        });
        return { statusCode: 200, body: this.mapPaymentIntent(intent) };
      }

      if (riskAssessment.decision === "review") {
        assertTransition(intent.status, "requires_action");
        intent.status = "requires_action";
        intent.updated_at = this.clock.nowIso();
        await this.repository.savePaymentIntent(intent);
        await this.publishEvent("payment_intent.requires_action", {
          payment_intent_id: intent.id,
          reason: riskAssessment.reason,
        });
        return { statusCode: 200, body: this.mapPaymentIntent(intent) };
      }

      const providers = this.providerRouter.selectCandidates(intent.payment_method_type);
      let finalFailureCode = "provider_unavailable";
      let authorized = false;

      for (const provider of providers) {
        const authorization = await provider.authorize({
          amount: intent.amount,
          currency: intent.currency,
          paymentMethodType: intent.payment_method_type,
          paymentMethodToken: intent.payment_method_token,
        });
        this.providerRouter.recordAuthorizeOutcome(provider.name, authorization);

        intent.provider = provider.name;
        intent.provider_reference = authorization.reference;
        intent.updated_at = this.clock.nowIso();

        if (authorization.ok) {
          authorized = true;
          break;
        }

        finalFailureCode = authorization.failureCode ?? "provider_declined";
        if (!isTransientProviderFailure(authorization.failureCode)) {
          break;
        }
      }

      if (!authorized) {
        assertTransition(intent.status, "failed");
        intent.status = "failed";
        await this.repository.savePaymentIntent(intent);
        await this.publishEvent("payment_intent.failed", {
          payment_intent_id: intent.id,
          failure_code: finalFailureCode,
        });
        return { statusCode: 200, body: this.mapPaymentIntent(intent) };
      }

      intent.authorized_amount = intent.amount;
      await this.appendLedgerEntry({
        paymentIntentId: intent.id,
        entryType: "authorization",
        direction: "credit",
        amount: intent.authorized_amount,
        currency: intent.currency,
        provider: intent.provider,
        providerReference: intent.provider_reference,
      });
      if (intent.capture_method === "automatic") {
        assertTransition(intent.status, "succeeded");
        intent.status = "succeeded";
        intent.captured_amount = intent.amount;
        await this.appendLedgerEntry({
          paymentIntentId: intent.id,
          entryType: "capture",
          direction: "credit",
          amount: intent.amount,
          currency: intent.currency,
          provider: intent.provider,
          providerReference: intent.provider_reference,
        });
        await this.publishEvent("payment_intent.succeeded", {
          payment_intent_id: intent.id,
          amount: intent.amount,
        });
      } else {
        assertTransition(intent.status, "requires_action");
        intent.status = "requires_action";
        await this.publishEvent("payment_intent.requires_action", {
          payment_intent_id: intent.id,
          reason: "manual_capture_required",
        });
      }

      intent.updated_at = this.clock.nowIso();
      await this.repository.savePaymentIntent(intent);
      return { statusCode: 200, body: this.mapPaymentIntent(intent) };
    });
  }

  async capturePaymentIntent(
    id: string,
    amount: number,
    idempotencyKey: string,
  ): Promise<IdempotentResult<PaymentIntentResponse>> {
    const idempotencyScope = `capture_payment_intent:${id}`;
    const payloadFingerprint = fingerprintPayload({ payment_intent_id: id, amount });
    return this.executeIdempotent(idempotencyScope, idempotencyKey, payloadFingerprint, async () => {
      const intent = await this.getPaymentIntentRecordOrThrow(id);

      if (intent.capture_method !== "manual") {
        throw new AppError(409, "invalid_capture_method", "Capture only allowed for manual intents.");
      }

      if (intent.status !== "requires_action") {
        throw new AppError(
          409,
          "invalid_payment_state",
          `Capture is not allowed when payment is '${intent.status}'.`,
        );
      }

      if (!intent.provider_reference || !intent.provider) {
        throw new AppError(409, "missing_provider_reference", "Payment has no provider reference.");
      }

      if (amount <= 0) {
        throw new AppError(422, "invalid_amount", "Capture amount must be greater than zero.");
      }

      const capturable = intent.authorized_amount - intent.captured_amount;
      if (amount > capturable) {
        throw new AppError(
          422,
          "amount_exceeds_capturable",
          `Capture amount exceeds capturable value (${capturable}).`,
        );
      }

      assertTransition(intent.status, "processing");
      intent.status = "processing";
      intent.updated_at = this.clock.nowIso();
      await this.repository.savePaymentIntent(intent);
      await this.publishEvent("payment_intent.processing", { payment_intent_id: intent.id });

      const provider = this.providerRouter.findByName(intent.provider);
      const captureResult = await provider.capture({
        amount,
        reference: intent.provider_reference,
      });

      if (!captureResult.ok) {
        assertTransition(intent.status, "failed");
        intent.status = "failed";
        intent.updated_at = this.clock.nowIso();
        await this.repository.savePaymentIntent(intent);
        await this.publishEvent("payment_intent.failed", {
          payment_intent_id: intent.id,
          failure_code: captureResult.failureCode ?? "capture_rejected",
        });
        return { statusCode: 200, body: this.mapPaymentIntent(intent) };
      }

      intent.captured_amount += amount;
      intent.updated_at = this.clock.nowIso();
      await this.appendLedgerEntry({
        paymentIntentId: intent.id,
        entryType: "capture",
        direction: "credit",
        amount,
        currency: intent.currency,
        provider: intent.provider,
        providerReference: intent.provider_reference,
      });

      if (intent.captured_amount >= intent.authorized_amount) {
        assertTransition(intent.status, "succeeded");
        intent.status = "succeeded";
        await this.publishEvent("payment_intent.succeeded", {
          payment_intent_id: intent.id,
          amount: intent.captured_amount,
        });
      } else {
        assertTransition(intent.status, "requires_action");
        intent.status = "requires_action";
      }

      await this.repository.savePaymentIntent(intent);
      return { statusCode: 200, body: this.mapPaymentIntent(intent) };
    });
  }

  async cancelPaymentIntent(
    id: string,
    idempotencyKey: string,
  ): Promise<IdempotentResult<PaymentIntentResponse>> {
    const idempotencyScope = `cancel_payment_intent:${id}`;
    const payloadFingerprint = fingerprintPayload({ payment_intent_id: id });
    return this.executeIdempotent(idempotencyScope, idempotencyKey, payloadFingerprint, async () => {
      const intent = await this.getPaymentIntentRecordOrThrow(id);

      if (intent.status === "canceled") {
        return { statusCode: 200, body: this.mapPaymentIntent(intent) };
      }

      if (isTerminalStatus(intent.status) || intent.status === "processing") {
        throw new AppError(
          409,
          "invalid_payment_state",
          `Cancel is not allowed when payment is '${intent.status}'.`,
        );
      }

      assertTransition(intent.status, "canceled");
      intent.status = "canceled";
      intent.updated_at = this.clock.nowIso();
      await this.repository.savePaymentIntent(intent);
      await this.publishEvent("payment_intent.canceled", {
        payment_intent_id: intent.id,
      });

      return { statusCode: 200, body: this.mapPaymentIntent(intent) };
    });
  }

  async createRefund(
    input: CreateRefundInput,
    idempotencyKey: string,
  ): Promise<IdempotentResult<RefundResponse>> {
    const idempotencyScope = "create_refund";
    const payloadFingerprint = fingerprintPayload(input);
    return this.executeIdempotent(idempotencyScope, idempotencyKey, payloadFingerprint, async () => {
      const paymentIntent = await this.getPaymentIntentRecordOrThrow(input.payment_intent_id);

      if (!paymentIntent.provider_reference || !paymentIntent.provider) {
        throw new AppError(422, "refund_not_allowed", "Payment has no provider reference.");
      }

      if (input.amount <= 0) {
        throw new AppError(422, "invalid_amount", "Refund amount must be greater than zero.");
      }

      const refundable = paymentIntent.captured_amount - paymentIntent.refunded_amount;
      if (refundable <= 0 || input.amount > refundable) {
        throw new AppError(
          422,
          "amount_exceeds_refundable",
          `Refund amount exceeds refundable value (${Math.max(0, refundable)}).`,
        );
      }

      const provider = this.providerRouter.findByName(paymentIntent.provider);
      const providerRefund = await provider.refund({
        amount: input.amount,
        reference: paymentIntent.provider_reference,
      });

      const refund: RefundRecord = {
        id: `re_${randomUUID()}`,
        payment_intent_id: paymentIntent.id,
        amount: input.amount,
        status: providerRefund.ok ? "succeeded" : "failed",
        created_at: this.clock.nowIso(),
        ...(input.reason ? { reason: input.reason } : {}),
      };

      await this.repository.saveRefund(refund);

      if (providerRefund.ok) {
        paymentIntent.refunded_amount += input.amount;
        paymentIntent.updated_at = this.clock.nowIso();
        await this.repository.savePaymentIntent(paymentIntent);
        await this.appendLedgerEntry({
          paymentIntentId: paymentIntent.id,
          refundId: refund.id,
          entryType: "refund",
          direction: "debit",
          amount: refund.amount,
          currency: paymentIntent.currency,
          provider: paymentIntent.provider,
          providerReference: paymentIntent.provider_reference,
        });
        await this.publishEvent("refund.succeeded", {
          refund_id: refund.id,
          payment_intent_id: refund.payment_intent_id,
          amount: refund.amount,
        });
      } else {
        await this.publishEvent("refund.failed", {
          refund_id: refund.id,
          payment_intent_id: refund.payment_intent_id,
          amount: refund.amount,
          failure_code: providerRefund.failureCode ?? "refund_rejected",
        });
      }

      return { statusCode: 201, body: this.mapRefund(refund) };
    });
  }

  async listRefunds(input: RefundListInput): Promise<{
    data: RefundResponse[];
    hasMore: boolean;
    nextCursor?: string;
  }> {
    const page = await this.repository.listRefunds(input);
    return {
      data: page.data.map((refund) => this.mapRefund(refund)),
      hasMore: page.hasMore,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  async createChargeback(
    input: CreateChargebackInput,
    idempotencyKey: string,
  ): Promise<IdempotentResult<ChargebackResponse>> {
    const idempotencyScope = "create_chargeback";
    const payloadFingerprint = fingerprintPayload(input);
    return this.executeIdempotent(idempotencyScope, idempotencyKey, payloadFingerprint, async () => {
      const paymentIntent = await this.getPaymentIntentRecordOrThrow(input.payment_intent_id);
      const existingChargebacks = await this.listAllChargebacksForPayment(input.payment_intent_id);
      const reservedAmount = existingChargebacks
        .filter((item) => item.status === "open" || item.status === "under_review" || item.status === "lost")
        .reduce((sum, item) => sum + item.amount, 0);
      const disputableAmount = Math.max(0, paymentIntent.captured_amount - paymentIntent.refunded_amount - reservedAmount);
      if (disputableAmount <= 0 || input.amount > disputableAmount) {
        throw new AppError(
          422,
          "amount_exceeds_disputable",
          `Chargeback amount exceeds disputable value (${disputableAmount}).`,
        );
      }

      const timestamp = this.clock.nowIso();
      const chargeback: ChargebackRecord = {
        id: `cb_${randomUUID()}`,
        payment_intent_id: input.payment_intent_id,
        amount: input.amount,
        reason: input.reason,
        status: "open",
        ...(input.evidence_url ? { evidence_url: input.evidence_url } : {}),
        created_at: timestamp,
        updated_at: timestamp,
      };
      await this.repository.saveChargeback(chargeback);
      await this.publishEvent("chargeback.opened", {
        chargeback_id: chargeback.id,
        payment_intent_id: chargeback.payment_intent_id,
        amount: chargeback.amount,
        reason: chargeback.reason,
      });
      return {
        statusCode: 201,
        body: this.mapChargeback(chargeback),
      };
    });
  }

  async resolveChargeback(
    id: string,
    status: "under_review" | "won" | "lost",
    idempotencyKey: string,
  ): Promise<IdempotentResult<ChargebackResponse>> {
    const idempotencyScope = `resolve_chargeback:${id}`;
    const payloadFingerprint = fingerprintPayload({ chargeback_id: id, status });
    return this.executeIdempotent(idempotencyScope, idempotencyKey, payloadFingerprint, async () => {
      const chargeback = await this.repository.getChargebackById(id);
      if (!chargeback) {
        throw new AppError(404, "resource_not_found", `Chargeback '${id}' not found.`);
      }

      if (chargeback.status === status) {
        return { statusCode: 200, body: this.mapChargeback(chargeback) };
      }
      if (chargeback.status === "won" || chargeback.status === "lost") {
        throw new AppError(409, "invalid_chargeback_state", `Chargeback is already in terminal status '${chargeback.status}'.`);
      }

      chargeback.status = status;
      chargeback.updated_at = this.clock.nowIso();
      await this.repository.saveChargeback(chargeback);

      if (status === "lost") {
        const paymentIntent = await this.getPaymentIntentRecordOrThrow(chargeback.payment_intent_id);
        await this.appendLedgerEntry({
          paymentIntentId: chargeback.payment_intent_id,
          entryType: "chargeback",
          direction: "debit",
          amount: chargeback.amount,
          currency: paymentIntent.currency,
          provider: paymentIntent.provider,
          providerReference: paymentIntent.provider_reference,
        });
        await this.publishEvent("chargeback.lost", {
          chargeback_id: chargeback.id,
          payment_intent_id: chargeback.payment_intent_id,
          amount: chargeback.amount,
        });
      } else if (status === "won") {
        await this.publishEvent("chargeback.won", {
          chargeback_id: chargeback.id,
          payment_intent_id: chargeback.payment_intent_id,
          amount: chargeback.amount,
        });
      }

      return { statusCode: 200, body: this.mapChargeback(chargeback) };
    });
  }

  async listChargebacks(input: ChargebackListInput): Promise<{
    data: ChargebackResponse[];
    hasMore: boolean;
    nextCursor?: string;
  }> {
    const page = await this.repository.listChargebacks(input);
    return {
      data: page.data.map((chargeback) => this.mapChargeback(chargeback)),
      hasMore: page.hasMore,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  async listLedgerEntries(input: LedgerEntryListInput): Promise<{
    data: LedgerEntryResponse[];
    hasMore: boolean;
    nextCursor?: string;
  }> {
    const page = await this.repository.listLedgerEntries(input);
    return {
      data: page.data.map((entry) => this.mapLedgerEntry(entry)),
      hasMore: page.hasMore,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  async summarizeReconciliation(input: {
    currency?: string;
    createdFrom?: string;
    createdTo?: string;
  }): Promise<{
    currency?: string;
    created_from?: string;
    created_to?: string;
    totals: {
      captured_total: number;
      refunded_total: number;
      chargeback_total: number;
      net_settled_total: number;
      entry_count: number;
    };
  }> {
    let cursor: string | undefined;
    let hasMore = true;
    let capturedTotal = 0;
    let refundedTotal = 0;
    let chargebackTotal = 0;
    let entryCount = 0;

    while (hasMore) {
      const page = await this.repository.listLedgerEntries({
        limit: 500,
        ...(cursor ? { cursor } : {}),
        ...(input.currency ? { currency: input.currency } : {}),
        ...(input.createdFrom ? { createdFrom: input.createdFrom } : {}),
        ...(input.createdTo ? { createdTo: input.createdTo } : {}),
      });
      for (const entry of page.data) {
        entryCount += 1;
        if (entry.entry_type === "capture") {
          capturedTotal += entry.direction === "credit" ? entry.amount : -entry.amount;
        } else if (entry.entry_type === "refund") {
          refundedTotal += entry.direction === "debit" ? entry.amount : -entry.amount;
        } else if (entry.entry_type === "chargeback") {
          chargebackTotal += entry.direction === "debit" ? entry.amount : -entry.amount;
        }
      }
      hasMore = page.hasMore;
      cursor = page.nextCursor;
      if (hasMore && !cursor) {
        throw new AppError(500, "reconciliation_cursor_error", "Cursor pagination failed while summarizing reconciliation.");
      }
    }

    return {
      ...(input.currency ? { currency: input.currency } : {}),
      ...(input.createdFrom ? { created_from: input.createdFrom } : {}),
      ...(input.createdTo ? { created_to: input.createdTo } : {}),
      totals: {
        captured_total: capturedTotal,
        refunded_total: refundedTotal,
        chargeback_total: chargebackTotal,
        net_settled_total: capturedTotal - refundedTotal - chargebackTotal,
        entry_count: entryCount,
      },
    };
  }

  private async executeIdempotent<TBody>(
    scope: string,
    key: string,
    fingerprint: string,
    operation: () => Promise<{ statusCode: number; body: TBody }>,
  ): Promise<IdempotentResult<TBody>> {
    return this.idempotencyStore.withKeyLock(scope, key, async () => {
      const existing = await this.idempotencyStore.get<TBody>(scope, key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new AppError(
            409,
            "idempotency_conflict",
            "Idempotency key already used with a different payload.",
          );
        }
        return {
          statusCode: existing.statusCode,
          body: existing.body,
          idempotencyReplayed: true,
        };
      }

      const result = await operation();
      await this.idempotencyStore.put(scope, key, {
        fingerprint,
        statusCode: result.statusCode,
        body: result.body,
        createdAt: this.clock.nowIso(),
      });
      return {
        statusCode: result.statusCode,
        body: result.body,
        idempotencyReplayed: false,
      };
    });
  }

  private mapPaymentIntent(intent: PaymentIntentRecord): PaymentIntentResponse {
    return {
      id: intent.id,
      amount: intent.amount,
      currency: intent.currency,
      status: intent.status,
      capture_method: intent.capture_method,
      customer_id: intent.customer_id,
      payment_method_type: intent.payment_method_type,
      authorized_amount: intent.authorized_amount,
      captured_amount: intent.captured_amount,
      refunded_amount: intent.refunded_amount,
      amount_refundable: Math.max(0, intent.captured_amount - intent.refunded_amount),
      provider: intent.provider,
      provider_reference: intent.provider_reference,
      created_at: intent.created_at,
      updated_at: intent.updated_at,
    };
  }

  private mapRefund(refund: RefundRecord): RefundResponse {
    return {
      id: refund.id,
      payment_intent_id: refund.payment_intent_id,
      amount: refund.amount,
      status: refund.status,
      created_at: refund.created_at,
    };
  }

  private mapChargeback(chargeback: ChargebackRecord): ChargebackResponse {
    return {
      id: chargeback.id,
      payment_intent_id: chargeback.payment_intent_id,
      amount: chargeback.amount,
      reason: chargeback.reason,
      status: chargeback.status,
      ...(chargeback.evidence_url ? { evidence_url: chargeback.evidence_url } : {}),
      created_at: chargeback.created_at,
      updated_at: chargeback.updated_at,
    };
  }

  private mapLedgerEntry(entry: LedgerEntryRecord): LedgerEntryResponse {
    return {
      id: entry.id,
      payment_intent_id: entry.payment_intent_id,
      refund_id: entry.refund_id,
      entry_type: entry.entry_type,
      direction: entry.direction,
      amount: entry.amount,
      currency: entry.currency,
      provider: entry.provider,
      provider_reference: entry.provider_reference,
      created_at: entry.created_at,
    };
  }

  private async publishEvent(type: PaymentEvent["type"], data: Record<string, unknown>): Promise<void> {
    const event: PaymentEvent = {
      id: `evt_${randomUUID()}`,
      api_version: this.eventApiVersion,
      source: this.eventSource,
      event_version: this.eventSchemaVersion,
      type,
      occurred_at: this.clock.nowIso(),
      data,
    };
    await this.eventBus.publish(event);
  }

  private async getPaymentIntentRecordOrThrow(id: string): Promise<PaymentIntentRecord> {
    const intent = await this.repository.getPaymentIntentById(id);
    if (!intent) {
      throw new AppError(404, "resource_not_found", `Payment intent '${id}' not found.`);
    }
    return intent;
  }

  private async appendLedgerEntry(input: {
    paymentIntentId: string;
    refundId?: string;
    entryType: LedgerEntryRecord["entry_type"];
    direction: LedgerEntryRecord["direction"];
    amount: number;
    currency: string;
    provider: string | null;
    providerReference: string | null;
  }): Promise<void> {
    await this.repository.saveLedgerEntry({
      id: `led_${randomUUID()}`,
      payment_intent_id: input.paymentIntentId,
      refund_id: input.refundId ?? null,
      entry_type: input.entryType,
      direction: input.direction,
      amount: input.amount,
      currency: input.currency,
      provider: input.provider,
      provider_reference: input.providerReference,
      created_at: this.clock.nowIso(),
    });
  }

  private async listAllChargebacksForPayment(paymentIntentId: string): Promise<ChargebackRecord[]> {
    const items: ChargebackRecord[] = [];
    let cursor: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const page = await this.repository.listChargebacks({
        limit: 200,
        ...(cursor ? { cursor } : {}),
        paymentIntentId,
      });
      items.push(...page.data);
      hasMore = page.hasMore;
      cursor = page.nextCursor;
      if (hasMore && !cursor) {
        throw new AppError(500, "chargeback_cursor_error", "Cursor pagination failed while loading chargebacks.");
      }
    }

    return items;
  }
}
