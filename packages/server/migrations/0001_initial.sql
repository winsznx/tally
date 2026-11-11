-- Tally API schema.
--
-- The server is an untrusted transport, index and read model. Signed entries
-- are stored as received and never edited or deleted; clients re-verify every
-- entry and every payment, so nothing here is a trust anchor.

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TABLE tabs (
  id         text PRIMARY KEY CHECK (id ~ '^[a-z2-7]{26}$'),
  network    smallint NOT NULL CHECK (network IN (5, 24)),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE entries (
  -- Global cursor. Appends to one tab are serialised by a row lock on the tab,
  -- so within a tab seq values become visible in increasing order and
  -- `seq > after` never skips a late commit.
  seq             bigserial PRIMARY KEY,
  tab_id          text NOT NULL REFERENCES tabs (id),
  entry_id        text NOT NULL CHECK (entry_id ~ '^[0-9a-f]{64}$'),
  entry_hash      text NOT NULL CHECK (entry_hash ~ '^[0-9a-f]{64}$'),
  prev_entry_hash text CHECK (prev_entry_hash ~ '^[0-9a-f]{64}$'),
  entry_type      text NOT NULL,
  author_address  text NOT NULL CHECK (author_address ~ '^[0-9a-f]{40}$'),
  -- bigint, not int: core accepts any safe integer clock.
  logical_clock   bigint NOT NULL CHECK (logical_clock >= 0),
  entry_json      text NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tab_id, entry_id)
);

CREATE INDEX entries_tab_seq ON entries (tab_id, seq);
CREATE INDEX entries_tab_membership ON entries (tab_id, seq)
  WHERE entry_type IN ('LEDGER_OPEN', 'MEMBER_JOIN', 'MEMBER_LEAVE');

CREATE TRIGGER entries_append_only
  BEFORE UPDATE OR DELETE ON entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE payment_intents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tab_id              text NOT NULL REFERENCES tabs (id),
  payer               text NOT NULL CHECK (payer ~ '^[0-9a-f]{40}$'),
  recipient           text NOT NULL CHECK (recipient ~ '^[0-9a-f]{40}$'),
  amount              numeric(20, 0) NOT NULL CHECK (amount > 0),
  ref                 text NOT NULL CHECK (ref ~ '^[a-z2-7]{16}$'),
  memo                text NOT NULL,
  -- The ledger genesis hash the memo was derived from, kept so a chain check
  -- does not need a full replay of the tab.
  genesis_hash        text NOT NULL CHECK (genesis_hash ~ '^[0-9a-f]{64}$'),
  network             smallint NOT NULL CHECK (network IN (5, 24)),
  tx_hash             text CHECK (tx_hash ~ '^[0-9a-f]{64}$'),
  state               text NOT NULL DEFAULT 'created'
                        CHECK (state IN ('created', 'submitted', 'observed', 'confirmed', 'failed', 'mismatch', 'unknown')),
  idempotency_key     text NOT NULL,
  block_number        bigint,
  last_status         text,
  last_reason         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  last_checked_at     timestamptz,
  next_check_at       timestamptz,
  check_count         integer NOT NULL DEFAULT 0,
  UNIQUE (tab_id, ref),
  UNIQUE (tab_id, idempotency_key)
);

CREATE UNIQUE INDEX payment_intents_tx_hash ON payment_intents (tx_hash) WHERE tx_hash IS NOT NULL;
CREATE INDEX payment_intents_tab ON payment_intents (tab_id, created_at DESC);
CREATE INDEX payment_intents_due ON payment_intents (last_checked_at NULLS FIRST)
  WHERE tx_hash IS NOT NULL AND state IN ('submitted', 'observed', 'unknown');

CREATE TABLE payment_observations (
  id             bigserial PRIMARY KEY,
  intent_id      uuid REFERENCES payment_intents (id),
  tx_hash        text NOT NULL CHECK (tx_hash ~ '^[0-9a-f]{64}$'),
  network        smallint NOT NULL CHECK (network IN (5, 24)),
  block_number   bigint,
  head_height    bigint,
  status         text NOT NULL CHECK (status IN ('confirmed', 'observed', 'pending', 'mismatch', 'failed', 'unknown')),
  reason         text,
  source_rpc     text NOT NULL,
  payload_digest text CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  observed_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payment_observations_intent ON payment_observations (intent_id, id DESC);
CREATE INDEX payment_observations_tx ON payment_observations (tx_hash, id DESC);

CREATE TRIGGER payment_observations_append_only
  BEFORE UPDATE OR DELETE ON payment_observations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE client_events (
  id          bigserial PRIMARY KEY,
  event       text NOT NULL,
  install_id  text NOT NULL CHECK (install_id ~ '^[A-Za-z0-9_-]{16,64}$'),
  app_version text NOT NULL CHECK (length(app_version) BETWEEN 1 AND 32),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX client_events_event ON client_events (event);
