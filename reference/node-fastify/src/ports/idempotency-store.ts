export interface IdempotencyRecord<TBody> {
  fingerprint: string;
  statusCode: number;
  body: TBody;
  createdAt: string;
}

export interface IdempotencyStorePort {
  get<TBody>(scope: string, key: string): Promise<IdempotencyRecord<TBody> | null>;
  put<TBody>(scope: string, key: string, record: IdempotencyRecord<TBody>): Promise<void>;
  withKeyLock<TOutput>(scope: string, key: string, operation: () => Promise<TOutput>): Promise<TOutput>;
}
