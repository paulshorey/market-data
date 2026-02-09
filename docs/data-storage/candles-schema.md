# Candles Schema: TimescaleDB Setup

## Architecture

`candles_1s` is the **sole source of truth**. All trades are aggregated into 1-second candles. Higher timeframes (`candles_1m`, `candles_5m`, `candles_1h`, etc.) are **TimescaleDB continuous aggregates** that auto-update when new 1s rows are inserted.

```
TBBO trades
  → scripts/ingest/tbbo-1s.ts (historical batch)
  → src/stream/tbbo-aggregator.ts (live real-time)
      ↓
candles_1s (hypertable, source of truth)
      ↓ continuous aggregates (auto-updated)
candles_1m
      ↓
candles_5m, candles_15m, candles_1h, ...
      ↓
candles_1d, candles_1w
```

## Design Principles

**Store raw building blocks, derive ratios at query time.** The base table stores values that aggregate cleanly with `sum()`, `max()`, `min()`, `first()`, `last()`. Derived ratios (vd_ratio, book_imbalance, price_pct, vwap, divergence) are calculated at query time or in the application layer from the raw components.

This means every metric is **exactly correct at every timeframe** -- no approximation from aggregating ratios.

## Column Reference

| Column | Type | Aggregation | Description |
|---|---|---|---|
| `time` | TIMESTAMPTZ | `time_bucket()` | Candle timestamp |
| `ticker` | TEXT | GROUP BY | Stitched contract name (e.g., "ES") |
| `open` | DOUBLE PRECISION | `first(open, time)` | Opening price |
| `high` | DOUBLE PRECISION | `max(high)` | Highest price |
| `low` | DOUBLE PRECISION | `min(low)` | Lowest price |
| `close` | DOUBLE PRECISION | `last(close, time)` | Closing price |
| `volume` | DOUBLE PRECISION | `sum(volume)` | Total volume |
| `ask_volume` | DOUBLE PRECISION | `sum(ask_volume)` | Aggressive buy volume (trades at ask) |
| `bid_volume` | DOUBLE PRECISION | `sum(bid_volume)` | Aggressive sell volume (trades at bid) |
| `cvd_open` | DOUBLE PRECISION | `first(cvd_open, time)` | CVD at start of period |
| `cvd_high` | DOUBLE PRECISION | `max(cvd_high)` | Highest CVD during period |
| `cvd_low` | DOUBLE PRECISION | `min(cvd_low)` | Lowest CVD during period |
| `cvd_close` | DOUBLE PRECISION | `last(cvd_close, time)` | CVD at end of period |
| `vd` | DOUBLE PRECISION | `sum(vd)` | Volume delta (ask_volume - bid_volume) |
| `trades` | INTEGER | `sum(trades)` | Number of trades |
| `max_trade_size` | DOUBLE PRECISION | `max(max_trade_size)` | Largest single trade |
| `big_trades` | INTEGER | `sum(big_trades)` | Count of large trades |
| `big_volume` | DOUBLE PRECISION | `sum(big_volume)` | Volume from large trades |

**Derived at query time** (not stored, calculated from raw columns):

| Derived metric | Formula | Description |
|---|---|---|
| `vd_ratio` | `vd / NULLIF(ask_volume + bid_volume, 0)` | Normalized VD, bounded -1 to +1 |
| `price_pct` | `(close - open) / NULLIF(open, 0) * 10000` | Price change in basis points |
| `big_trade_pct` | `big_volume / NULLIF(volume, 0)` | Large trade participation rate |

## Step 1: Create the Base Hypertable

```sql
-- ============================================================================
-- candles_1s: 1-second OHLCV + order flow (source of truth)
-- ============================================================================

CREATE TABLE candles_1s (
  time           TIMESTAMPTZ      NOT NULL,
  ticker         TEXT             NOT NULL,
  -- Price OHLCV
  open           DOUBLE PRECISION NOT NULL,
  high           DOUBLE PRECISION NOT NULL,
  low            DOUBLE PRECISION NOT NULL,
  close          DOUBLE PRECISION NOT NULL,
  volume         DOUBLE PRECISION NOT NULL DEFAULT 0,
  -- Volume breakdown (raw building blocks for VD aggregation)
  ask_volume     DOUBLE PRECISION NOT NULL DEFAULT 0,
  bid_volume     DOUBLE PRECISION NOT NULL DEFAULT 0,
  -- CVD OHLC (only metric with intra-candle OHLC tracking)
  cvd_open       DOUBLE PRECISION,
  cvd_high       DOUBLE PRECISION,
  cvd_low        DOUBLE PRECISION,
  cvd_close      DOUBLE PRECISION,
  -- Volume Delta (single value = ask_volume - bid_volume)
  vd             DOUBLE PRECISION,
  -- Activity
  trades         INTEGER          DEFAULT 0,
  max_trade_size DOUBLE PRECISION DEFAULT 0,
  big_trades     INTEGER          DEFAULT 0,
  big_volume     DOUBLE PRECISION DEFAULT 0,
  -- Primary key
  PRIMARY KEY (ticker, time)
);

-- Convert to TimescaleDB hypertable (1-week chunks for 1s data)
SELECT create_hypertable('candles_1s', by_range('time', INTERVAL '1 week'));
```

## Step 2: Create the 1-Minute Continuous Aggregate

```sql
-- ============================================================================
-- candles_1m: 1-minute candles (auto-aggregated from candles_1s)
-- ============================================================================

CREATE MATERIALIZED VIEW candles_1m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 minute', time) AS time,
  ticker,
  -- Price OHLCV
  first(open, time) AS open,
  max(high) AS high,
  min(low) AS low,
  last(close, time) AS close,
  sum(volume) AS volume,
  -- Volume breakdown
  sum(ask_volume) AS ask_volume,
  sum(bid_volume) AS bid_volume,
  -- CVD OHLC
  first(cvd_open, time) AS cvd_open,
  max(cvd_high) AS cvd_high,
  min(cvd_low) AS cvd_low,
  last(cvd_close, time) AS cvd_close,
  -- Volume Delta
  sum(vd) AS vd,
  -- Activity
  sum(trades) AS trades,
  max(max_trade_size) AS max_trade_size,
  sum(big_trades) AS big_trades,
  sum(big_volume) AS big_volume
FROM candles_1s
GROUP BY time_bucket('1 minute', time), ticker
WITH NO DATA;
```

## Step 3: Create Higher-Timeframe Aggregates

All higher timeframes aggregate from `candles_1m` (not directly from `candles_1s`). This is more efficient: aggregating 60 rows for 1h vs 3600 rows.

```sql
-- ============================================================================
-- Standard timeframes (from candles_1m)
-- ============================================================================

CREATE MATERIALIZED VIEW candles_5m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('5 minutes', time) AS time,
  ticker,
  first(open, time) AS open, max(high) AS high,
  min(low) AS low, last(close, time) AS close,
  sum(volume) AS volume,
  sum(ask_volume) AS ask_volume, sum(bid_volume) AS bid_volume,
  first(cvd_open, time) AS cvd_open, max(cvd_high) AS cvd_high,
  min(cvd_low) AS cvd_low, last(cvd_close, time) AS cvd_close,
  sum(vd) AS vd,
  sum(trades) AS trades, max(max_trade_size) AS max_trade_size,
  sum(big_trades) AS big_trades, sum(big_volume) AS big_volume
FROM candles_1m
GROUP BY time_bucket('5 minutes', time), ticker
WITH NO DATA;

CREATE MATERIALIZED VIEW candles_15m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('15 minutes', time) AS time,
  ticker,
  first(open, time) AS open, max(high) AS high,
  min(low) AS low, last(close, time) AS close,
  sum(volume) AS volume,
  sum(ask_volume) AS ask_volume, sum(bid_volume) AS bid_volume,
  first(cvd_open, time) AS cvd_open, max(cvd_high) AS cvd_high,
  min(cvd_low) AS cvd_low, last(cvd_close, time) AS cvd_close,
  sum(vd) AS vd,
  sum(trades) AS trades, max(max_trade_size) AS max_trade_size,
  sum(big_trades) AS big_trades, sum(big_volume) AS big_volume
FROM candles_1m
GROUP BY time_bucket('15 minutes', time), ticker
WITH NO DATA;

CREATE MATERIALIZED VIEW candles_1h
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', time) AS time,
  ticker,
  first(open, time) AS open, max(high) AS high,
  min(low) AS low, last(close, time) AS close,
  sum(volume) AS volume,
  sum(ask_volume) AS ask_volume, sum(bid_volume) AS bid_volume,
  first(cvd_open, time) AS cvd_open, max(cvd_high) AS cvd_high,
  min(cvd_low) AS cvd_low, last(cvd_close, time) AS cvd_close,
  sum(vd) AS vd,
  sum(trades) AS trades, max(max_trade_size) AS max_trade_size,
  sum(big_trades) AS big_trades, sum(big_volume) AS big_volume
FROM candles_1m
GROUP BY time_bucket('1 hour', time), ticker
WITH NO DATA;

CREATE MATERIALIZED VIEW candles_1d
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 day', time) AS time,
  ticker,
  first(open, time) AS open, max(high) AS high,
  min(low) AS low, last(close, time) AS close,
  sum(volume) AS volume,
  sum(ask_volume) AS ask_volume, sum(bid_volume) AS bid_volume,
  first(cvd_open, time) AS cvd_open, max(cvd_high) AS cvd_high,
  min(cvd_low) AS cvd_low, last(cvd_close, time) AS cvd_close,
  sum(vd) AS vd,
  sum(trades) AS trades, max(max_trade_size) AS max_trade_size,
  sum(big_trades) AS big_trades, sum(big_volume) AS big_volume
FROM candles_1h
GROUP BY time_bucket('1 day', time), ticker
WITH NO DATA;
```

Custom prime-number timeframes (for backtesting):

```sql
-- Example: 7-minute candles
CREATE MATERIALIZED VIEW candles_7m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('7 minutes', time) AS time,
  ticker,
  first(open, time) AS open, max(high) AS high,
  min(low) AS low, last(close, time) AS close,
  sum(volume) AS volume,
  sum(ask_volume) AS ask_volume, sum(bid_volume) AS bid_volume,
  first(cvd_open, time) AS cvd_open, max(cvd_high) AS cvd_high,
  min(cvd_low) AS cvd_low, last(cvd_close, time) AS cvd_close,
  sum(vd) AS vd,
  sum(trades) AS trades, max(max_trade_size) AS max_trade_size,
  sum(big_trades) AS big_trades, sum(big_volume) AS big_volume
FROM candles_1m
GROUP BY time_bucket('7 minutes', time), ticker
WITH NO DATA;
```

Repeat this pattern for any custom timeframe (13m, 29m, 59m, 109m, 181m, etc.).

## Step 4: Refresh Policies (Auto-Update)

These policies tell TimescaleDB to automatically refresh the aggregates as new data arrives.

```sql
-- ============================================================================
-- Refresh policies: keep aggregates current
-- ============================================================================

-- candles_1m: refresh every 10 seconds, look back 5 minutes
SELECT add_continuous_aggregate_policy('candles_1m',
  start_offset => INTERVAL '5 minutes',
  end_offset   => INTERVAL '10 seconds',
  schedule_interval => INTERVAL '10 seconds'
);

-- candles_5m: refresh every minute, look back 15 minutes
SELECT add_continuous_aggregate_policy('candles_5m',
  start_offset => INTERVAL '15 minutes',
  end_offset   => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute'
);

-- candles_15m: refresh every 5 minutes, look back 1 hour
SELECT add_continuous_aggregate_policy('candles_15m',
  start_offset => INTERVAL '1 hour',
  end_offset   => INTERVAL '1 minute',
  schedule_interval => INTERVAL '5 minutes'
);

-- candles_1h: refresh every 10 minutes, look back 3 hours
SELECT add_continuous_aggregate_policy('candles_1h',
  start_offset => INTERVAL '3 hours',
  end_offset   => INTERVAL '1 minute',
  schedule_interval => INTERVAL '10 minutes'
);

-- candles_1d: refresh every hour, look back 3 days
SELECT add_continuous_aggregate_policy('candles_1d',
  start_offset => INTERVAL '3 days',
  end_offset   => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour'
);
```

## Step 5: Indexes

```sql
-- ============================================================================
-- Indexes for common query patterns
-- ============================================================================

-- The PRIMARY KEY (ticker, time) already creates an index.
-- TimescaleDB automatically creates chunk-level indexes.

-- For time-range queries when ticker is not specified:
CREATE INDEX idx_candles_1s_time ON candles_1s (time DESC);
```

## Step 6: Compression (Optional, for Production)

```sql
-- ============================================================================
-- Compression: reduce storage for older data
-- ============================================================================

ALTER TABLE candles_1s SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'ticker',
  timescaledb.compress_orderby = 'time DESC'
);

-- Auto-compress chunks older than 1 week
SELECT add_compression_policy('candles_1s', INTERVAL '1 week');
```

## Step 7: Backfill Existing Data

After inserting historical data into `candles_1s`, refresh all aggregates:

```sql
CALL refresh_continuous_aggregate('candles_1m', NULL, NULL);
CALL refresh_continuous_aggregate('candles_5m', NULL, NULL);
CALL refresh_continuous_aggregate('candles_15m', NULL, NULL);
CALL refresh_continuous_aggregate('candles_1h', NULL, NULL);
CALL refresh_continuous_aggregate('candles_1d', NULL, NULL);
```

## Querying Derived Metrics

Since derived ratios are not stored, calculate them at query time:

```sql
-- Query with all derived metrics at any timeframe
SELECT
  time,
  ticker,
  open, high, low, close,
  volume,
  -- Raw order flow
  ask_volume,
  bid_volume,
  vd,
  -- CVD
  cvd_open, cvd_high, cvd_low, cvd_close,
  -- Derived metrics (calculated from raw columns)
  vd / NULLIF(ask_volume + bid_volume, 0) AS vd_ratio,
  (close - open) / NULLIF(open, 0) * 10000 AS price_pct,
  big_volume / NULLIF(volume, 0) AS big_trade_pct,
  -- Activity
  trades,
  max_trade_size,
  big_trades,
  big_volume
FROM candles_1m
WHERE ticker = 'ES'
  AND time >= NOW() - INTERVAL '1 day'
ORDER BY time;
```

This query works identically against `candles_1s`, `candles_1m`, `candles_1h`, or any other timeframe -- the derived metrics are always correct because they're calculated from properly aggregated raw values.

## Teardown (Start Fresh)

To drop everything and start over:

```sql
-- Drop in reverse dependency order (views first, then base table)
DROP MATERIALIZED VIEW IF EXISTS candles_1d CASCADE;
DROP MATERIALIZED VIEW IF EXISTS candles_1h CASCADE;
DROP MATERIALIZED VIEW IF EXISTS candles_15m CASCADE;
DROP MATERIALIZED VIEW IF EXISTS candles_5m CASCADE;
DROP MATERIALIZED VIEW IF EXISTS candles_1m CASCADE;
DROP TABLE IF EXISTS candles_1s CASCADE;
```

## Adding Custom Timeframes

Any integer-minute timeframe can be added as a continuous aggregate from `candles_1m`:

```sql
-- Example: 29-minute candles
CREATE MATERIALIZED VIEW candles_29m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('29 minutes', time) AS time,
  ticker,
  first(open, time) AS open, max(high) AS high,
  min(low) AS low, last(close, time) AS close,
  sum(volume) AS volume,
  sum(ask_volume) AS ask_volume, sum(bid_volume) AS bid_volume,
  first(cvd_open, time) AS cvd_open, max(cvd_high) AS cvd_high,
  min(cvd_low) AS cvd_low, last(cvd_close, time) AS cvd_close,
  sum(vd) AS vd,
  sum(trades) AS trades, max(max_trade_size) AS max_trade_size,
  sum(big_trades) AS big_trades, sum(big_volume) AS big_volume
FROM candles_1m
GROUP BY time_bucket('29 minutes', time), ticker
WITH NO DATA;

SELECT add_continuous_aggregate_policy('candles_29m',
  start_offset => INTERVAL '87 minutes',  -- 3x period
  end_offset   => INTERVAL '1 minute',
  schedule_interval => INTERVAL '29 minutes'
);
```

## Code Changes Summary

### What writes to `candles_1s`
- **`scripts/ingest/tbbo-1s.ts`** -- Historical batch ingest (ready)
- **`src/stream/tbbo-aggregator.ts`** -- Live stream (TODO: change from 1m to 1s aggregation interval, then point at `candles_1s`)

### What reads from the tables
- **`src/lib/candles.ts`** -- REST API (updated to use new table names)
- **Continuous aggregates** -- `candles_1m`, `candles_5m`, etc. auto-read from their source

### `scripts/ingest/tbbo-1m.ts` -- DEPRECATED
This script directly wrote 1-minute candles to `"candles-1m"`. With the new schema, 1-minute candles are auto-generated by the `candles_1m` continuous aggregate. Use `tbbo-1s.ts` instead.

### Live stream TODO
The live aggregator (`src/stream/tbbo-aggregator.ts`) currently:
1. Aggregates trades into 1-minute candles
2. Writes to the old `"candles-1m"` table

To complete the migration, it needs to:
1. Aggregate trades into 1-second candles (change flush interval and bucket logic)
2. Write to `candles_1s` instead
3. Let the continuous aggregate handle `candles_1m` and higher timeframes

## Migration Notes

The old tables (`"candles-1m"`, `"candles-1s"`) used hyphens and quoted identifiers. The new tables use underscores (`candles_1s`, `candles_1m`) -- no quoting needed.

Key schema changes from old to new:
- **Added**: `ask_volume`, `bid_volume` (raw volume breakdown for clean aggregation)
- **Removed from storage**: `vd_ratio`, `book_imbalance`, `price_pct`, `divergence`, `symbol` (derived at query time or in application layer)
- **Renamed**: `"candles-1s"` to `candles_1s` (no hyphens)
- **`candles_1m`** is now a continuous aggregate VIEW, not a regular table. It cannot be written to directly.
