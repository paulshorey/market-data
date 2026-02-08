-- ============================================================================
-- candles-1s: 1-second OHLCV + order flow (slim schema)
-- ============================================================================
-- Same slim schema as candles-1m (21 columns). Use for ingest-databento-tbbo-1s.ts.
-- Run after candles-1m exists and slim migration has been applied there, so column
-- names match.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "candles-1s" (
  time         TIMESTAMPTZ NOT NULL,
  ticker       TEXT        NOT NULL,
  symbol       TEXT,
  open         DOUBLE PRECISION NOT NULL,
  high         DOUBLE PRECISION NOT NULL,
  low          DOUBLE PRECISION NOT NULL,
  close        DOUBLE PRECISION NOT NULL,
  volume       DOUBLE PRECISION NOT NULL,
  -- CVD OHLC
  cvd_open     DOUBLE PRECISION,
  cvd_high     DOUBLE PRECISION,
  cvd_low      DOUBLE PRECISION,
  cvd_close    DOUBLE PRECISION,
  -- Single-value order flow
  vd           DOUBLE PRECISION,
  vd_ratio     DOUBLE PRECISION,
  book_imbalance DOUBLE PRECISION,
  price_pct    DOUBLE PRECISION,
  -- Activity
  trades       INTEGER,
  max_trade_size DOUBLE PRECISION,
  big_trades   INTEGER,
  big_volume   DOUBLE PRECISION,
  divergence   SMALLINT,
  PRIMARY KEY (ticker, time)
);

-- Optional: index for time-range queries per ticker
-- CREATE INDEX IF NOT EXISTS idx_candles_1s_ticker_time ON "candles-1s" (ticker, time DESC);
