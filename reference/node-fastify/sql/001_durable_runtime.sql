CREATE TABLE IF NOT EXISTS pmc_idempotency_keys (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  body JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE INDEX IF NOT EXISTS pmc_idempotency_expires_at_idx
  ON pmc_idempotency_keys (expires_at);

CREATE TABLE IF NOT EXISTS pmc_outbox_events (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payment_intent_id TEXT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  published_at TIMESTAMPTZ NULL,
  stream_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pmc_outbox_occurred_idx
  ON pmc_outbox_events (occurred_at DESC, event_id DESC);

CREATE INDEX IF NOT EXISTS pmc_outbox_payment_intent_idx
  ON pmc_outbox_events (payment_intent_id);

CREATE INDEX IF NOT EXISTS pmc_outbox_event_type_idx
  ON pmc_outbox_events (event_type);

CREATE TABLE IF NOT EXISTS pmc_inbox_events (
  consumer_group TEXT NOT NULL,
  event_id TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (consumer_group, event_id)
);

CREATE TABLE IF NOT EXISTS pmc_payment_intents (
  id TEXT PRIMARY KEY,
  amount BIGINT NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL,
  status TEXT NOT NULL,
  capture_method TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  payment_method_type TEXT NOT NULL,
  payment_method_token TEXT NOT NULL,
  authorized_amount BIGINT NOT NULL CHECK (authorized_amount >= 0),
  captured_amount BIGINT NOT NULL CHECK (captured_amount >= 0),
  refunded_amount BIGINT NOT NULL CHECK (refunded_amount >= 0),
  provider TEXT NULL,
  provider_reference TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS pmc_payment_intents_created_idx
  ON pmc_payment_intents (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS pmc_payment_intents_status_idx
  ON pmc_payment_intents (status);

CREATE INDEX IF NOT EXISTS pmc_payment_intents_customer_idx
  ON pmc_payment_intents (customer_id);

CREATE INDEX IF NOT EXISTS pmc_payment_intents_provider_idx
  ON pmc_payment_intents (provider, provider_reference);

CREATE INDEX IF NOT EXISTS pmc_payment_intents_method_idx
  ON pmc_payment_intents (payment_method_type);

CREATE TABLE IF NOT EXISTS pmc_refunds (
  id TEXT PRIMARY KEY,
  payment_intent_id TEXT NOT NULL REFERENCES pmc_payment_intents (id),
  amount BIGINT NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL,
  reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS pmc_refunds_created_idx
  ON pmc_refunds (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS pmc_refunds_payment_intent_idx
  ON pmc_refunds (payment_intent_id);

CREATE INDEX IF NOT EXISTS pmc_refunds_status_idx
  ON pmc_refunds (status);

CREATE TABLE IF NOT EXISTS pmc_chargebacks (
  id TEXT PRIMARY KEY,
  payment_intent_id TEXT NOT NULL REFERENCES pmc_payment_intents (id),
  amount BIGINT NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  evidence_url TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS pmc_chargebacks_created_idx
  ON pmc_chargebacks (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS pmc_chargebacks_payment_intent_idx
  ON pmc_chargebacks (payment_intent_id);

CREATE INDEX IF NOT EXISTS pmc_chargebacks_status_idx
  ON pmc_chargebacks (status);

CREATE TABLE IF NOT EXISTS pmc_ledger_entries (
  id TEXT PRIMARY KEY,
  payment_intent_id TEXT NOT NULL REFERENCES pmc_payment_intents (id),
  refund_id TEXT NULL REFERENCES pmc_refunds (id),
  entry_type TEXT NOT NULL,
  direction TEXT NOT NULL,
  amount BIGINT NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL,
  provider TEXT NULL,
  provider_reference TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS pmc_ledger_created_idx
  ON pmc_ledger_entries (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS pmc_ledger_payment_intent_idx
  ON pmc_ledger_entries (payment_intent_id);

CREATE INDEX IF NOT EXISTS pmc_ledger_refund_idx
  ON pmc_ledger_entries (refund_id);

CREATE INDEX IF NOT EXISTS pmc_ledger_entry_type_idx
  ON pmc_ledger_entries (entry_type);

CREATE INDEX IF NOT EXISTS pmc_ledger_direction_idx
  ON pmc_ledger_entries (direction);

CREATE INDEX IF NOT EXISTS pmc_ledger_currency_idx
  ON pmc_ledger_entries (currency);
