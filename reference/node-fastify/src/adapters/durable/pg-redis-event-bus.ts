import type { Redis } from "ioredis";
import type { Pool } from "pg";
import type { PaymentEvent } from "../../domain/types.js";
import { AppError } from "../../infra/app-error.js";
import type { EventBusPort, PaymentEventListInput, PaymentEventListResult } from "../../ports/event-bus.js";

interface PgRedisEventBusOptions {
  streamKey: string;
  consumerGroup: string;
  consumerName: string;
  blockMs: number;
  batchSize: number;
}

type StreamMessageFields = string[];
type StreamMessage = [string, StreamMessageFields];
type StreamResponse = [string, StreamMessage[]];

function fieldValue(fields: StreamMessageFields, name: string): string | undefined {
  for (let index = 0; index < fields.length; index += 2) {
    if (fields[index] === name) {
      return fields[index + 1];
    }
  }
  return undefined;
}

export class PgRedisDurableEventBus implements EventBusPort {
  private readonly subscribers: Array<(event: PaymentEvent) => Promise<void>> = [];
  private readonly consumerRedis: Redis;
  private running = false;
  private consumerLoopPromise: Promise<void> | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly redis: Redis,
    private readonly options: PgRedisEventBusOptions,
  ) {
    // Dedicated connection avoids BLOCK read starving publish commands.
    this.consumerRedis = this.redis.duplicate();
  }

  async publish(event: PaymentEvent): Promise<void> {
    const paymentIntentId = typeof event.data.payment_intent_id === "string" ? event.data.payment_intent_id : null;
    await this.pool.query(
      `
        INSERT INTO pmc_outbox_events (
          event_id,
          event_type,
          payment_intent_id,
          occurred_at,
          payload
        )
        VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb)
        ON CONFLICT (event_id) DO NOTHING
      `,
      [event.id, event.type, paymentIntentId, event.occurred_at, JSON.stringify(event)],
    );

    const streamId = await this.redis.xadd(
      this.options.streamKey,
      "*",
      "event_id",
      event.id,
      "event_json",
      JSON.stringify(event),
    );

    await this.pool.query(
      `
        UPDATE pmc_outbox_events
        SET published_at = NOW(),
            stream_id = $2
        WHERE event_id = $1
      `,
      [event.id, streamId],
    );
  }

  subscribe(handler: (event: PaymentEvent) => Promise<void>): void {
    this.subscribers.push(handler);
    if (!this.running) {
      this.running = true;
      this.consumerLoopPromise = this.runConsumerLoop();
    }
  }

  async listPublishedEvents(input: PaymentEventListInput): Promise<PaymentEventListResult> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let index = 1;

    conditions.push("published_at IS NOT NULL");
    if (input.paymentIntentId) {
      conditions.push(`payment_intent_id = $${index}`);
      values.push(input.paymentIntentId);
      index += 1;
    }
    if (input.eventType) {
      conditions.push(`event_type = $${index}`);
      values.push(input.eventType);
      index += 1;
    }
    if (input.occurredFrom) {
      conditions.push(`occurred_at >= $${index}::timestamptz`);
      values.push(input.occurredFrom);
      index += 1;
    }
    if (input.occurredTo) {
      conditions.push(`occurred_at <= $${index}::timestamptz`);
      values.push(input.occurredTo);
      index += 1;
    }

    const result = await this.pool.query<{ event_id: string; payload: PaymentEvent }>(
      `
        SELECT event_id, payload
        FROM pmc_outbox_events
        WHERE ${conditions.join(" AND ")}
        ORDER BY occurred_at DESC, event_id DESC
      `,
      values,
    );
    const items = result.rows.map((row) => row.payload);
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

  async close(): Promise<void> {
    this.running = false;
    if (this.consumerLoopPromise) {
      await this.consumerLoopPromise;
      this.consumerLoopPromise = null;
    }
    await this.consumerRedis.quit();
  }

  private async runConsumerLoop(): Promise<void> {
    await this.ensureConsumerGroup();
    while (this.running) {
      if (this.subscribers.length === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        continue;
      }
      try {
        const response = (await this.consumerRedis.xreadgroup(
          "GROUP",
          this.options.consumerGroup,
          this.options.consumerName,
          "COUNT",
          String(this.options.batchSize),
          "BLOCK",
          String(this.options.blockMs),
          "STREAMS",
          this.options.streamKey,
          ">",
        )) as StreamResponse[] | null;

        if (!response || response.length === 0) {
          continue;
        }

        for (const [, messages] of response) {
          for (const [streamEntryId, fields] of messages) {
            const eventJson = fieldValue(fields, "event_json");
            const eventId = fieldValue(fields, "event_id");
            if (!eventJson || !eventId) {
              await this.consumerRedis.xack(this.options.streamKey, this.options.consumerGroup, streamEntryId);
              continue;
            }

            const event = JSON.parse(eventJson) as PaymentEvent;
            const processed = await this.processWithInbox(event);
            if (processed) {
              await this.consumerRedis.xack(this.options.streamKey, this.options.consumerGroup, streamEntryId);
            }
          }
        }
      } catch {
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
      }
    }
  }

  private async processWithInbox(event: PaymentEvent): Promise<boolean> {
    const insertResult = await this.pool.query(
      `
        INSERT INTO pmc_inbox_events (consumer_group, event_id, processed_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (consumer_group, event_id) DO NOTHING
      `,
      [this.options.consumerGroup, event.id],
    );

    if (insertResult.rowCount === 0) {
      return true;
    }

    try {
      for (const subscriber of this.subscribers) {
        await subscriber(event);
      }
      return true;
    } catch {
      await this.pool.query(
        `
          DELETE FROM pmc_inbox_events
          WHERE consumer_group = $1
            AND event_id = $2
        `,
        [this.options.consumerGroup, event.id],
      );
      return false;
    }
  }

  private async ensureConsumerGroup(): Promise<void> {
    try {
      await this.redis.xgroup(
        "CREATE",
        this.options.streamKey,
        this.options.consumerGroup,
        "$",
        "MKSTREAM",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("BUSYGROUP")) {
        throw error;
      }
    }
  }

}
