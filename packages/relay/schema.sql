-- Tally relay schema (GAP 8). D1 (SQLite).
--
-- The relay is an UNTRUSTED store-and-forward. It verifies entry signatures only
-- to reject garbage; clients re-verify everything, so nothing here is a trust
-- anchor. It can omit, reorder, or go down. It cannot forge: every entry is
-- signed by a purse key bound to a real account.

CREATE TABLE IF NOT EXISTS ledgers (
  id        TEXT PRIMARY KEY,     -- unguessable, 128-bit, base32 (GAP 7)
  network   INTEGER NOT NULL,     -- 5 = testnet, 24 = mainnet (GAP 3)
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
  ledgerId      TEXT NOT NULL,
  entryId       TEXT NOT NULL,    -- client-derived content id; dedup key
  entryHash     TEXT NOT NULL,    -- client-derived entry hash; opaque cursor / head
  prevEntryHash TEXT,             -- null only for LEDGER_OPEN
  authorAddress TEXT NOT NULL,    -- for the distinct-account metric (GAP 6)
  payload       TEXT NOT NULL,    -- the full signed LogEntry, JSON, exactly as signed
  signature     TEXT NOT NULL,    -- purse signature (also inside payload; kept for quick checks)
  receivedAt    INTEGER NOT NULL,
  PRIMARY KEY (ledgerId, entryId) -- entry insert is idempotent on entryId
);

-- Ordered reads per ledger (GAP 8).
CREATE INDEX IF NOT EXISTS entries_by_received ON entries (ledgerId, receivedAt);
-- Cursor lookup for GET /since/:hash.
CREATE INDEX IF NOT EXISTS entries_by_hash ON entries (ledgerId, entryHash);
-- Distinct-account metric (GAP 6).
CREATE INDEX IF NOT EXISTS entries_by_author ON entries (authorAddress);

CREATE TABLE IF NOT EXISTS heads (
  ledgerId  TEXT PRIMARY KEY,
  headHash  TEXT NOT NULL,
  updatedAt INTEGER NOT NULL
);

-- Per-IP fixed-window rate limit. No PII: the ip is hashed before storage.
CREATE TABLE IF NOT EXISTS rate_limit (
  ipHash     TEXT NOT NULL,
  windowStart INTEGER NOT NULL,
  count      INTEGER NOT NULL,
  PRIMARY KEY (ipHash, windowStart)
);
