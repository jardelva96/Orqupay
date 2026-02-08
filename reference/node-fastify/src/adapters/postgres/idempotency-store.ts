import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type {
  IdempotencyRecord,
  IdempotencyStorePort,
} from "../../ports/idempotency-store.js";

interface PostgresIdempotencyStoreOptions {
  ttlSeconds: number;
}

function advisoryLockId(scope: string, key: string): bigint {
  const digest = createHash("sha256").update(`${scope}:${key}`).digest();
  const value = digest.readBigInt64BE(0);
  return value;
}

export class PostgresIdempotencyStore implements IdempotencyStorePort {
  constructor(
    private readonly pool: Pool,
    private readonly options: PostgresIdempotencyStoreOptions,
  ) {}

  async get<TBody>(scope: string, key: string): Promise<IdempotencyRecord<TBody> | null> {
    const result = await this.pool.query<{
      fingerprint: string;
      status_code: number;
      body: TBody;
      created_at: unknown;
      expires_at: unknown;
    }>(
      `
        SELECT fingerprint, status_code, body, created_at, expires_at
        FROM pmc_idempotency_keys
        WHERE scope = $1
          AND key = $2
      `,
      [scope, key],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }

    const expiresAt = row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at);
    if (Date.parse(expiresAt) <= Date.now()) {
      await this.pool.query(
        `
          DELETE FROM pmc_idempotency_keys
          WHERE scope = $1
            AND key = $2
        `,
        [scope, key],
      );
      return null;
    }

    return {
      fingerprint: row.fingerprint,
      statusCode: row.status_code,
      body: row.body,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    };
  }

  async put<TBody>(scope: string, key: string, record: IdempotencyRecord<TBody>): Promise<void> {
    const expiresAtMs = Date.parse(record.createdAt) + this.options.ttlSeconds * 1000;
    const expiresAt = new Date(expiresAtMs).toISOString();
    await this.pool.query(
      `
        INSERT INTO pmc_idempotency_keys (
          scope,
          key,
          fingerprint,
          status_code,
          body,
          created_at,
          expires_at
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz, $7::timestamptz)
        ON CONFLICT (scope, key) DO NOTHING
      `,
      [
        scope,
        key,
        record.fingerprint,
        record.statusCode,
        JSON.stringify(record.body),
        record.createdAt,
        expiresAt,
      ],
    );
  }

  async withKeyLock<TOutput>(
    scope: string,
    key: string,
    operation: () => Promise<TOutput>,
  ): Promise<TOutput> {
    const lockKey = advisoryLockId(scope, key);
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1::bigint)", [lockKey.toString()]);
      return await operation();
    } finally {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [lockKey.toString()]);
      client.release();
    }
  }
}
