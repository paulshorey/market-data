# Database Schema: Multi-Timeframe Rolling Windows

## Current State

The live pipeline writes to a single `"candles-1m"` table with 54 columns (OHLCV + 10 order flow metrics tracked as OHLC). See `src/lib/trade/db-writer.ts` for the full column list.

The target architecture below is designed but not yet implemented.

## Target Architecture: One Table Per Timeframe

All symbols share the same table, differentiated by a `symbol` column. ~10 tables total:

```
ohlcv_1m      (source of truth, from live stream)
ohlcv_3m      (rolling window, calculated from 1m)
ohlcv_5m
ohlcv_15m
ohlcv_30m
ohlcv_60m
ohlcv_120m
ohlcv_240m
ohlcv_720m
ohlcv_1440m   (1 day)
```

Custom timeframes (7m, 13m, 19m, 29m, 59m, 109m, 181m) can also be added.

## Schema

**Source table (1-minute):**

```sql
CREATE TABLE ohlcv_1m (
    symbol      VARCHAR(20) NOT NULL,
    ts          TIMESTAMPTZ NOT NULL,
    open        NUMERIC(18,8),
    high        NUMERIC(18,8),
    low         NUMERIC(18,8),
    close       NUMERIC(18,8),
    volume      NUMERIC(24,8),

    PRIMARY KEY (symbol, ts)
);

CREATE INDEX idx_ohlcv_1m_ts ON ohlcv_1m (ts DESC);
```

**Higher-timeframe tables (same structure + minute_index + indicators):**

```sql
CREATE TABLE ohlcv_60m (
    symbol        VARCHAR(20) NOT NULL,
    ts            TIMESTAMPTZ NOT NULL,
    minute_index  SMALLINT NOT NULL,  -- cycles 1 to 60

    -- Aggregated OHLCV (sliding window over past 60 1m candles)
    open          NUMERIC(18,8),
    high          NUMERIC(18,8),
    low           NUMERIC(18,8),
    close         NUMERIC(18,8),
    volume        NUMERIC(24,8),

    -- Indicator values (nullable until calculated)
    rsi_14        NUMERIC(8,4),
    ema_9         NUMERIC(18,8),
    ema_21        NUMERIC(18,8),
    sma_50        NUMERIC(18,8),
    sma_200       NUMERIC(18,8),
    atr_14        NUMERIC(18,8),
    macd_line     NUMERIC(18,8),
    macd_signal   NUMERIC(18,8),
    macd_hist     NUMERIC(18,8),
    -- Add more as needed

    PRIMARY KEY (symbol, ts)
);

-- Critical index for indicator lookups via minute_index
CREATE INDEX idx_ohlcv_60m_indicator_lookup
    ON ohlcv_60m (symbol, minute_index, ts DESC);

CREATE INDEX idx_ohlcv_60m_ts
    ON ohlcv_60m (ts DESC);
```

Repeat for each timeframe, adjusting table name and minute_index cycle length.

## How minute_index Works

For a 60-minute timeframe, `minute_index` cycles 1 through 60. Each value represents a "phase" of the hourly window:

- minute_index=1: rows at 10:00, 11:00, 12:00... (each 60 mins apart)
- minute_index=2: rows at 10:01, 11:01, 12:01... (each 60 mins apart)
- minute_index=31: rows at 10:30, 11:30, 12:30... (each 60 mins apart)

This means rows sharing the same minute_index form a series where consecutive entries are exactly one timeframe period apart -- exactly what indicators need.

## Query Patterns

**RSI-14 calculation (14 prior candles at same phase):**

```sql
SELECT close
FROM ohlcv_60m
WHERE symbol = 'ES'
  AND minute_index = 31
ORDER BY ts DESC
LIMIT 14;
```

This is an index-only scan on `(symbol, minute_index, ts DESC)`.

**Charting (recent candles for one symbol):**

```sql
SELECT ts, open, high, low, close, volume, rsi_14, macd_line
FROM ohlcv_60m
WHERE symbol = 'ES'
  AND ts >= NOW() - INTERVAL '7 days'
ORDER BY ts DESC;
```

**Backtesting (full data for a date range):**

```sql
SELECT *
FROM ohlcv_60m
WHERE symbol = 'ES'
  AND ts BETWEEN '2024-01-01' AND '2024-06-01'
ORDER BY ts;
```

## Design Decisions

**Indicators in same table (not separate):**
- Single query gets OHLCV + all indicators, no JOINs
- Adding new indicators is just `ALTER TABLE ... ADD COLUMN`
- Trade-off: schema changes require ALTER TABLE, but this is infrequent

**Partitioning (recommended at scale):**
- Composite: LIST by symbol first, then RANGE by month
- See [optimization.md](./optimization.md) for details

**Not needed:**
- Separate tables per symbol (symbols are rows, not tables)
- Separate tables per symbol-timeframe combo

## Visual Summary

```
┌─────────────────────────────────────────────────────────┐
│ ohlcv_1m (source of truth)                               │
│ ┌─────────┬─────────────────┬──────┬──────┬─────┬─────┐ │
│ │ symbol  │ ts              │ open │ high │ low │close│ │
│ ├─────────┼─────────────────┼──────┼──────┼─────┼─────┤ │
│ │ ES      │ 2024-01-15 10:00│ ...  │ ...  │ ... │ ... │ │
│ │ ES      │ 2024-01-15 10:01│ ...  │ ...  │ ... │ ... │ │
│ │ NQ      │ 2024-01-15 10:00│ ...  │ ...  │ ... │ ... │ │
│ └─────────┴─────────────────┴──────┴──────┴─────┴─────┘ │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼ (rolling-window pre-processing)
┌─────────────────────────────────────────────────────────┐
│ ohlcv_60m (sliding window, one row per minute)           │
│ ┌───────┬───────────┬─────┬──────┬──────┬─────┬───────┐ │
│ │symbol │ ts        │ idx │ open │ high │ ... │ rsi_14│ │
│ ├───────┼───────────┼─────┼──────┼──────┼─────┼───────┤ │
│ │ ES    │ 10:00     │  1  │ agg  │ agg  │ ... │ 54.2  │ │
│ │ ES    │ 10:01     │  2  │ agg  │ agg  │ ... │ 55.1  │ │
│ │ ES    │ 10:02     │  3  │ agg  │ agg  │ ... │ 53.8  │ │
│ │ NQ    │ 10:00     │  1  │ agg  │ agg  │ ... │ 48.7  │ │
│ └───────┴───────────┴─────┴──────┴──────┴─────┴───────┘ │
└─────────────────────────────────────────────────────────┘
```
