-- ============================================================================
-- Candles Schema Setup (TimescaleDB)
--
-- Source of truth: candles_1m (1-minute hypertable, written at 1-second resolution)
-- Higher timeframes: continuous aggregates (auto-updated materialized views)
--
-- The application writes rolling 1-minute candles every second. Each row
-- represents the trailing 60-second window of trade data, giving ~60 rows
-- per minute per ticker. Higher timeframes aggregate from this base table.
--
-- Run this script against a TimescaleDB database.
-- Full documentation: docs/data-storage/timescale-aggregators.md
-- ============================================================================


-- ── 1. Base hypertable ───────────────────────────────────────

-- Teardown (in reverse dependency order)
DROP MATERIALIZED VIEW IF EXISTS candles_60m CASCADE;
DROP MATERIALIZED VIEW IF EXISTS candles_15m CASCADE;
DROP MATERIALIZED VIEW IF EXISTS candles_5m CASCADE;
DROP TABLE IF EXISTS candles_1m CASCADE;

-- Create base table
CREATE TABLE candles_1m (
  time           TIMESTAMPTZ      NOT NULL,
  ticker         TEXT             NOT NULL,
  symbol         TEXT,
  open           DOUBLE PRECISION NOT NULL,
  high           DOUBLE PRECISION NOT NULL,
  low            DOUBLE PRECISION NOT NULL,
  close          DOUBLE PRECISION NOT NULL,
  volume         DOUBLE PRECISION NOT NULL DEFAULT 0,
  ask_volume     DOUBLE PRECISION NOT NULL DEFAULT 0,
  bid_volume     DOUBLE PRECISION NOT NULL DEFAULT 0,
  cvd_open       DOUBLE PRECISION,
  cvd_high       DOUBLE PRECISION,
  cvd_low        DOUBLE PRECISION,
  cvd_close      DOUBLE PRECISION,
  vd             DOUBLE PRECISION,
  vd_ratio       DOUBLE PRECISION,
  book_imbalance DOUBLE PRECISION,
  price_pct      DOUBLE PRECISION,
  divergence     DOUBLE PRECISION,
  trades         INTEGER          DEFAULT 0,
  max_trade_size DOUBLE PRECISION DEFAULT 0,
  big_trades     INTEGER          DEFAULT 0,
  big_volume     DOUBLE PRECISION DEFAULT 0,
  -- Raw accumulators for higher-timeframe aggregation
  sum_bid_depth    DOUBLE PRECISION DEFAULT 0,
  sum_ask_depth    DOUBLE PRECISION DEFAULT 0,
  sum_price_volume DOUBLE PRECISION DEFAULT 0,
  unknown_volume   DOUBLE PRECISION DEFAULT 0,
  PRIMARY KEY (ticker, time)
);

-- Convert to hypertable (1-week chunks)
SELECT create_hypertable('candles_1m', by_range('time', INTERVAL '1 week'));

-- If candles_1m already exists as a regular PostgreSQL table with data:
-- SELECT create_hypertable('candles_1m', by_range('time', INTERVAL '1 week'),
--   migrate_data => true
-- );


-- ── 2. Indexes ───────────────────────────────────────────────
CREATE INDEX idx_candles_1m_time ON candles_1m (time DESC);


-- ── 3. Compression ───────────────────────────────────────────
ALTER TABLE candles_1m SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'ticker',
  timescaledb.compress_orderby = 'time DESC'
);
SELECT add_compression_policy('candles_1m', INTERVAL '1 week');

-- Check compression status
SELECT
  chunk_name,
  before_compression_total_bytes,
  after_compression_total_bytes,
  compression_ratio
FROM chunk_compression_stats('candles_1m')
ORDER BY chunk_name;

-- List all chunks
SELECT show_chunks('candles_1m');

-- Compress one
SELECT compress_chunk('_timescaledb_internal._hyper_1_1_chunk');

-- Decompress (needed before INSERT into old time ranges)
SELECT decompress_chunk('_timescaledb_internal._hyper_1_1_chunk');


-- ── 4. Higher-timeframe continuous aggregates ──────────────────
--
-- These aggregate from candles_1m (the base hypertable).
-- Derived metrics (vd_ratio, book_imbalance, vwap, price_pct, divergence)
-- are recomputed from raw accumulators — NEVER averaged from lower TF ratios.
--
-- TimescaleDB supports hierarchical continuous aggregates (cagg-on-cagg)
-- since v2.9. Each layer references the one below it.

-- 5-minute (from 1-minute)
CREATE MATERIALIZED VIEW candles_5m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('5 minutes', time) AS time, ticker,
  -- Price OHLC
  first(open, time) AS open, max(high) AS high,
  min(low) AS low, last(close, time) AS close,
  -- Additive raw values
  sum(volume) AS volume,
  sum(ask_volume) AS ask_volume,
  sum(bid_volume) AS bid_volume,
  sum(unknown_volume) AS unknown_volume,
  -- CVD OHLC
  first(cvd_open, time) AS cvd_open,
  max(cvd_high) AS cvd_high,
  min(cvd_low) AS cvd_low,
  last(cvd_close, time) AS cvd_close,
  -- Raw accumulators (additive)
  sum(sum_bid_depth) AS sum_bid_depth,
  sum(sum_ask_depth) AS sum_ask_depth,
  sum(sum_price_volume) AS sum_price_volume,
  -- Recomputed derived metrics
  sum(ask_volume) - sum(bid_volume) AS vd,
  (sum(ask_volume) - sum(bid_volume))
    / NULLIF(sum(ask_volume) + sum(bid_volume), 0) AS vd_ratio,
  (sum(sum_bid_depth) - sum(sum_ask_depth))
    / NULLIF(sum(sum_bid_depth) + sum(sum_ask_depth), 0) AS book_imbalance,
  sum(sum_price_volume) / NULLIF(sum(volume), 0) AS vwap,
  -- Activity
  sum(trades) AS trades,
  max(max_trade_size) AS max_trade_size,
  sum(big_trades) AS big_trades,
  sum(big_volume) AS big_volume
FROM candles_1m
GROUP BY time_bucket('5 minutes', time), ticker
WITH NO DATA;

-- 15-minute (from 5-minute)
CREATE MATERIALIZED VIEW candles_15m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('15 minutes', time) AS time, ticker,
  -- Price OHLC
  first(open, time) AS open, max(high) AS high,
  min(low) AS low, last(close, time) AS close,
  -- Additive raw values
  sum(volume) AS volume,
  sum(ask_volume) AS ask_volume,
  sum(bid_volume) AS bid_volume,
  sum(unknown_volume) AS unknown_volume,
  -- CVD OHLC
  first(cvd_open, time) AS cvd_open,
  max(cvd_high) AS cvd_high,
  min(cvd_low) AS cvd_low,
  last(cvd_close, time) AS cvd_close,
  -- Raw accumulators (additive)
  sum(sum_bid_depth) AS sum_bid_depth,
  sum(sum_ask_depth) AS sum_ask_depth,
  sum(sum_price_volume) AS sum_price_volume,
  -- Recomputed derived metrics
  sum(ask_volume) - sum(bid_volume) AS vd,
  (sum(ask_volume) - sum(bid_volume))
    / NULLIF(sum(ask_volume) + sum(bid_volume), 0) AS vd_ratio,
  (sum(sum_bid_depth) - sum(sum_ask_depth))
    / NULLIF(sum(sum_bid_depth) + sum(sum_ask_depth), 0) AS book_imbalance,
  sum(sum_price_volume) / NULLIF(sum(volume), 0) AS vwap,
  -- Activity
  sum(trades) AS trades,
  max(max_trade_size) AS max_trade_size,
  sum(big_trades) AS big_trades,
  sum(big_volume) AS big_volume
FROM candles_5m
GROUP BY time_bucket('15 minutes', time), ticker
WITH NO DATA;

-- 60-minute (from 15-minute)
CREATE MATERIALIZED VIEW candles_60m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('60 minutes', time) AS time, ticker,
  -- Price OHLC
  first(open, time) AS open, max(high) AS high,
  min(low) AS low, last(close, time) AS close,
  -- Additive raw values
  sum(volume) AS volume,
  sum(ask_volume) AS ask_volume,
  sum(bid_volume) AS bid_volume,
  sum(unknown_volume) AS unknown_volume,
  -- CVD OHLC
  first(cvd_open, time) AS cvd_open,
  max(cvd_high) AS cvd_high,
  min(cvd_low) AS cvd_low,
  last(cvd_close, time) AS cvd_close,
  -- Raw accumulators (additive)
  sum(sum_bid_depth) AS sum_bid_depth,
  sum(sum_ask_depth) AS sum_ask_depth,
  sum(sum_price_volume) AS sum_price_volume,
  -- Recomputed derived metrics
  sum(ask_volume) - sum(bid_volume) AS vd,
  (sum(ask_volume) - sum(bid_volume))
    / NULLIF(sum(ask_volume) + sum(bid_volume), 0) AS vd_ratio,
  (sum(sum_bid_depth) - sum(sum_ask_depth))
    / NULLIF(sum(sum_bid_depth) + sum(sum_ask_depth), 0) AS book_imbalance,
  sum(sum_price_volume) / NULLIF(sum(volume), 0) AS vwap,
  -- Activity
  sum(trades) AS trades,
  max(max_trade_size) AS max_trade_size,
  sum(big_trades) AS big_trades,
  sum(big_volume) AS big_volume
FROM candles_15m
GROUP BY time_bucket('60 minutes', time), ticker
WITH NO DATA;


-- ── 5. Refresh policies ─────────────────────────────────────

-- 5m: refresh every 30s, looking back 15 minutes
SELECT add_continuous_aggregate_policy('candles_5m',
  start_offset => INTERVAL '15 minutes',
  end_offset   => INTERVAL '1 minute',
  schedule_interval => INTERVAL '30 seconds');

-- 15m: refresh every 1 minute, looking back 30 minutes
SELECT add_continuous_aggregate_policy('candles_15m',
  start_offset => INTERVAL '30 minutes',
  end_offset   => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute');

-- 60m: refresh every 5 minutes, looking back 2 hours
SELECT add_continuous_aggregate_policy('candles_60m',
  start_offset => INTERVAL '2 hours',
  end_offset   => INTERVAL '5 minutes',
  schedule_interval => INTERVAL '5 minutes');


-- ── 6. Backfill (run after loading historical data) ──────────
-- Refresh in order from lowest to highest timeframe
CALL refresh_continuous_aggregate('candles_5m', NULL, NULL);
CALL refresh_continuous_aggregate('candles_15m', NULL, NULL);
CALL refresh_continuous_aggregate('candles_60m', NULL, NULL);


-- ── 7. Example: Deriving additional metrics at query time ────
--
-- price_pct and divergence are computed from the aggregated data,
-- not stored in the continuous aggregates (to avoid schema bloat):
--
--   SELECT *,
--     ((close - open) / NULLIF(open, 0)) * 100 AS price_pct,
--     CASE
--       WHEN ((close - open) / NULLIF(open, 0)) * 100 > 0 AND vd_ratio < 0 THEN -1  -- bearish divergence
--       WHEN ((close - open) / NULLIF(open, 0)) * 100 < 0 AND vd_ratio > 0 THEN 1   -- bullish divergence
--       ELSE 0
--     END AS divergence
--   FROM candles_5m
--   WHERE ticker = 'ES' AND time > NOW() - INTERVAL '1 day'
--   ORDER BY time;
