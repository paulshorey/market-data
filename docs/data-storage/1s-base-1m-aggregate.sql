-- ============================================================================
-- Candles Schema Setup (TimescaleDB)
--
-- Source of truth: candles_1s (1-second hypertable)
-- Higher timeframes: continuous aggregates (auto-updated materialized views)
--
-- Run this script against a TimescaleDB database.
-- Full documentation: docs/data-storage/timescale-aggregators.md
-- ============================================================================


-- ── 1. Base hypertable ───────────────────────────────────────

-- Teardown
DROP MATERIALIZED VIEW IF EXISTS candles_1m CASCADE;
DROP TABLE IF EXISTS candles_1s CASCADE;

-- Create base table
CREATE TABLE candles_1s (
  time           TIMESTAMPTZ      NOT NULL,
  ticker         TEXT             NOT NULL,
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
  trades         INTEGER          DEFAULT 0,
  max_trade_size DOUBLE PRECISION DEFAULT 0,
  big_trades     INTEGER          DEFAULT 0,
  big_volume     DOUBLE PRECISION DEFAULT 0,
  PRIMARY KEY (ticker, time)
);
-- Convert to hypertable to enable TimescaleDB aggregation features
SELECT create_hypertable('candles_1s', by_range('time', INTERVAL '1 week'));
-- If table already has data, add: migrate_data => true
SELECT create_hypertable('candles_1s', by_range('time', INTERVAL '1 week'), migrate_data => true);

-- If `candles_1s` already exists as a regular PostgreSQL table with data:
-- Convert existing table to hypertable
-- migrate_data => true moves existing rows into chunks
SELECT create_hypertable('candles_1s', by_range('time', INTERVAL '1 week'),
  migrate_data => true
);

-- If the table has a different primary key or constraints that conflict, you may need to drop and recreate them first:
-- If needed: drop old PK, add the correct one, then convert
ALTER TABLE candles_1s DROP CONSTRAINT IF EXISTS candles_1s_pkey;
ALTER TABLE candles_1s ADD PRIMARY KEY (ticker, time);
SELECT create_hypertable('candles_1s', by_range('time', INTERVAL '1 week'),
  migrate_data => true
);


-- ── 2. Indexes ───────────────────────────────────────────────
CREATE INDEX idx_candles_1s_time ON candles_1s (time DESC);


-- ── 3. Compression ───────────────────────────────────────────
ALTER TABLE candles_1s SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'ticker',
  timescaledb.compress_orderby = 'time DESC'
);
SELECT add_compression_policy('candles_1s', INTERVAL '1 week');

-- Check compression status
SELECT
  chunk_name,
  before_compression_total_bytes,
  after_compression_total_bytes,
  compression_ratio
FROM chunk_compression_stats('candles_1s')
ORDER BY chunk_name;

-- List all chunks
SELECT show_chunks('candles_1s');

-- Compress one
SELECT compress_chunk('_timescaledb_internal._hyper_1_1_chunk');

-- Decompress (needed before INSERT into old time ranges)
SELECT decompress_chunk('_timescaledb_internal._hyper_1_1_chunk');


-- ── 4. Continuous aggregates ─────────────────────────────────

-- 1-minute (from 1-second)
CREATE MATERIALIZED VIEW candles_1m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 minute', time) AS time, ticker,
  first(open, time) AS open, max(high) AS high,
  min(low) AS low, last(close, time) AS close,
  sum(volume) AS volume,
  sum(ask_volume) AS ask_volume, sum(bid_volume) AS bid_volume,
  first(cvd_open, time) AS cvd_open, max(cvd_high) AS cvd_high,
  min(cvd_low) AS cvd_low, last(cvd_close, time) AS cvd_close,
  sum(vd) AS vd,
  sum(trades) AS trades, max(max_trade_size) AS max_trade_size,
  sum(big_trades) AS big_trades, sum(big_volume) AS big_volume
FROM candles_1s
GROUP BY time_bucket('1 minute', time), ticker
WITH NO DATA;


-- ── 5. Refresh policies ─────────────────────────────────────
SELECT add_continuous_aggregate_policy('candles_1m',
  start_offset => INTERVAL '5 minutes',
  end_offset   => INTERVAL '10 seconds',
  schedule_interval => INTERVAL '10 seconds');


-- ── 6. Backfill (run after loading historical data) ──────────
CALL refresh_continuous_aggregate('candles_1m', NULL, NULL);
