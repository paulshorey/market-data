# Candles Schema: TimescaleDB Setup

## Architecture

`candles_1m` is the **sole source of truth**. Rolling 1-minute candles are written at 1-second resolution (up to 60 rows per minute per ticker). Higher timeframes (`candles_5m`, `candles_15m`, `candles_60m`) are **TimescaleDB continuous aggregates** that auto-update from `candles_1m`.

```
TBBO trades
  → scripts/ingest/tbbo-1m-1s.ts (historical batch)
  → src/stream/tbbo-1m-aggregator.ts (live real-time)
      ↓
candles_1m (hypertable, source of truth — written every second)
      ↓ continuous aggregates (auto-updated)
candles_5m, candles_15m, candles_60m
```

## Design Principles

**Store raw building blocks, derive ratios at query time.** The base table stores values that aggregate cleanly with `sum()`, `max()`, `min()`, `first()`, `last()`. Derived ratios (vd_ratio, book_imbalance, vwap) are stored in the base table for convenience, but higher-timeframe aggregates recompute them from the raw accumulators (sum_price_volume, sum_bid_depth, sum_ask_depth).

This means every metric is **exactly correct at every timeframe** — no approximation from aggregating ratios.

## Column Reference

| Column | Type | Aggregation | Description |
|---|---|---|---|
| `time` | TIMESTAMPTZ | `time_bucket()` | Candle timestamp |
| `ticker` | TEXT | GROUP BY | Stitched contract name (e.g., "ES") |
| `symbol` | TEXT | — | Raw contract symbol (e.g., "ESH5") |
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
| `vd_ratio` | DOUBLE PRECISION | recompute | Normalized VD, bounded -1 to +1 |
| `book_imbalance` | DOUBLE PRECISION | recompute | Order book imbalance |
| `price_pct` | DOUBLE PRECISION | recompute | Price change percentage |
| `divergence` | DOUBLE PRECISION | recompute | Price/VD divergence signal |
| `trades` | INTEGER | `sum(trades)` | Number of trades |
| `max_trade_size` | DOUBLE PRECISION | `max(max_trade_size)` | Largest single trade |
| `big_trades` | INTEGER | `sum(big_trades)` | Count of large trades |
| `big_volume` | DOUBLE PRECISION | `sum(big_volume)` | Volume from large trades |
| `sum_bid_depth` | DOUBLE PRECISION | `sum(sum_bid_depth)` | Raw bid depth accumulator |
| `sum_ask_depth` | DOUBLE PRECISION | `sum(sum_ask_depth)` | Raw ask depth accumulator |
| `sum_price_volume` | DOUBLE PRECISION | `sum(sum_price_volume)` | Raw price×volume accumulator (for VWAP) |
| `unknown_volume` | DOUBLE PRECISION | `sum(unknown_volume)` | Volume with unknown trade side |

**Derived at higher timeframes** (recomputed from raw accumulators, not averaged):

| Derived metric | Formula | Description |
|---|---|---|
| `vd_ratio` | `(sum(ask_volume) - sum(bid_volume)) / NULLIF(sum(ask_volume) + sum(bid_volume), 0)` | Normalized VD |
| `book_imbalance` | `(sum(sum_bid_depth) - sum(sum_ask_depth)) / NULLIF(sum(sum_bid_depth) + sum(sum_ask_depth), 0)` | Order book imbalance |
| `vwap` | `sum(sum_price_volume) / NULLIF(sum(volume), 0)` | Volume-weighted average price |

## Full SQL Setup

See **`1s-base-1m-aggregate.sql`** for the complete, runnable schema. It includes:

1. `candles_1m` base hypertable creation
2. Index and compression setup
3. `candles_5m`, `candles_15m`, `candles_60m` continuous aggregates
4. Refresh policies for auto-updates
5. Backfill commands for historical data

## What Writes to `candles_1m`

- **`scripts/ingest/tbbo-1m-1s.ts`** — Historical batch ingest from TBBO JSONL files
- **`src/stream/tbbo-1m-aggregator.ts`** — Live real-time stream from Databento

Both use the same shared libraries (`src/lib/trade/`, `src/lib/metrics/`) and the same `db-writer.ts` to ensure identical output.

## What Reads from the Tables

- **`src/lib/candles.ts`** — REST API (auto-selects best timeframe for requested date range)
- **Continuous aggregates** — `candles_5m`, `candles_15m`, `candles_60m` auto-read from `candles_1m`

## Querying with Derived Metrics

```sql
SELECT
  time, ticker,
  open, high, low, close, volume,
  ask_volume, bid_volume, vd,
  cvd_open, cvd_high, cvd_low, cvd_close,
  -- Derived metrics (already stored in candles_1m, recomputed in aggregates)
  vd_ratio,
  book_imbalance,
  sum_price_volume / NULLIF(volume, 0) AS vwap,
  ((close - open) / NULLIF(open, 0)) * 100 AS price_pct,
  trades, max_trade_size, big_trades, big_volume
FROM candles_5m
WHERE ticker = 'ES'
  AND time >= NOW() - INTERVAL '1 day'
ORDER BY time;
```

This query pattern works identically against `candles_1m`, `candles_5m`, `candles_15m`, or `candles_60m` — derived metrics are always correct because they're calculated from properly aggregated raw values.

## Teardown (Start Fresh)

```sql
-- Drop in reverse dependency order (views first, then base table)
DROP MATERIALIZED VIEW IF EXISTS candles_60m CASCADE;
DROP MATERIALIZED VIEW IF EXISTS candles_15m CASCADE;
DROP MATERIALIZED VIEW IF EXISTS candles_5m CASCADE;
DROP TABLE IF EXISTS candles_1m CASCADE;
```

## Adding Custom Timeframes

Any integer-minute timeframe can be added as a continuous aggregate from `candles_1m`:

```sql
CREATE MATERIALIZED VIEW candles_29m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('29 minutes', time) AS time, ticker,
  first(open, time) AS open, max(high) AS high,
  min(low) AS low, last(close, time) AS close,
  sum(volume) AS volume,
  sum(ask_volume) AS ask_volume, sum(bid_volume) AS bid_volume,
  sum(unknown_volume) AS unknown_volume,
  first(cvd_open, time) AS cvd_open, max(cvd_high) AS cvd_high,
  min(cvd_low) AS cvd_low, last(cvd_close, time) AS cvd_close,
  sum(sum_bid_depth) AS sum_bid_depth,
  sum(sum_ask_depth) AS sum_ask_depth,
  sum(sum_price_volume) AS sum_price_volume,
  sum(ask_volume) - sum(bid_volume) AS vd,
  (sum(ask_volume) - sum(bid_volume))
    / NULLIF(sum(ask_volume) + sum(bid_volume), 0) AS vd_ratio,
  (sum(sum_bid_depth) - sum(sum_ask_depth))
    / NULLIF(sum(sum_bid_depth) + sum(sum_ask_depth), 0) AS book_imbalance,
  sum(sum_price_volume) / NULLIF(sum(volume), 0) AS vwap,
  sum(trades) AS trades, max(max_trade_size) AS max_trade_size,
  sum(big_trades) AS big_trades, sum(big_volume) AS big_volume
FROM candles_1m
GROUP BY time_bucket('29 minutes', time), ticker
WITH NO DATA;

SELECT add_continuous_aggregate_policy('candles_29m',
  start_offset => INTERVAL '87 minutes',
  end_offset   => INTERVAL '1 minute',
  schedule_interval => INTERVAL '29 minutes'
);
```
