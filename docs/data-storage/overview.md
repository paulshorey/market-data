# Storing financial data - by timeframe, for technical analysis strategy backtesting

## One table per timeframe

All symbols go in the same table, differentiated by a `symbol` column. You end up with ~10 tables total:

```
ohlcv_1m      (source of truth)
ohlcv_3m      (calculated)
ohlcv_5m      (calculated)
ohlcv_15m     (calculated)
ohlcv_30m     (calculated)
ohlcv_60m     (calculated)
ohlcv_120m    (calculated)
ohlcv_240m    (calculated)
ohlcv_720m    (calculated)
ohlcv_1440m   (calculated, aka 1D)
```

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

**Calculated higher-timeframe tables (identical structure + minute_index + indicators):**

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
    rsi_21        NUMERIC(8,4),
    macd_line     NUMERIC(18,8),
    macd_signal   NUMERIC(18,8),
    macd_hist     NUMERIC(18,8),
    ema_9         NUMERIC(18,8),
    ema_21        NUMERIC(18,8),
    sma_50        NUMERIC(18,8),
    sma_200       NUMERIC(18,8),
    atr_14        NUMERIC(18,8),
    -- Add more as needed

    PRIMARY KEY (symbol, ts)
);

-- Critical index for your minute_index query pattern
CREATE INDEX idx_ohlcv_60m_indicator_lookup
    ON ohlcv_60m (symbol, minute_index, ts DESC);

-- Useful for time-range queries
CREATE INDEX idx_ohlcv_60m_ts
    ON ohlcv_60m (ts DESC);
```

Repeat for each timeframe, adjusting the table name and minute_index cycle length.

## Why this structure works

**Query for RSI-14 calculation (fetching 14 prior closes):**

```sql
SELECT close
FROM ohlcv_60m
WHERE symbol = 'BTCUSDT'
  AND minute_index = 31
ORDER BY ts DESC
LIMIT 14;
```

This is an index-only scan on `(symbol, minute_index, ts DESC)`—essentially instant.

**Query for charting (fetch recent candles for one symbol):**

```sql
SELECT ts, open, high, low, close, volume, rsi_14, macd_line
FROM ohlcv_60m
WHERE symbol = 'BTCUSDT'
  AND ts >= NOW() - INTERVAL '7 days'
ORDER BY ts DESC;
```

**Query for backtesting (fetch all data for one symbol in a date range):**

```sql
SELECT *
FROM ohlcv_60m
WHERE symbol = 'BTCUSDT'
  AND ts BETWEEN '2024-01-01' AND '2024-06-01'
ORDER BY ts;
```

## Indicator columns: same table vs separate table

**Same table (recommended for your use case):**

- Pros: Single query gets everything, simpler application code, no JOINs
- Cons: Schema changes require ALTER TABLE when adding indicators

**Separate indicators table:**

- Pros: Flexible schema, can add indicators without touching OHLCV tables
- Cons: Requires JOINs, more complex queries

Since you likely have a known set of indicators and want fast single-query access for backtesting, keeping them in the same row makes sense. You can always add columns later:

```sql
ALTER TABLE ohlcv_60m ADD COLUMN bollinger_upper NUMERIC(18,8);
```

## Partitioning (optional but recommended at scale)

For large datasets, partition by time:

```sql
CREATE TABLE ohlcv_60m (
    symbol        VARCHAR(20) NOT NULL,
    ts            TIMESTAMPTZ NOT NULL,
    minute_index  SMALLINT NOT NULL,
    open          NUMERIC(18,8),
    high          NUMERIC(18,8),
    low           NUMERIC(18,8),
    close         NUMERIC(18,8),
    volume        NUMERIC(24,8),
    rsi_14        NUMERIC(8,4),
    -- etc.
    PRIMARY KEY (symbol, ts)
) PARTITION BY RANGE (ts);

-- Create monthly partitions
CREATE TABLE ohlcv_60m_2024_01 PARTITION OF ohlcv_60m
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
CREATE TABLE ohlcv_60m_2024_02 PARTITION OF ohlcv_60m
    FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');
-- etc.
```

This keeps individual partitions smaller and allows fast drops of old data.

## Summary of table count

| What       | Count                           |
| ---------- | ------------------------------- |
| Timeframes | 10                              |
| Tables     | 10 (one per timeframe)          |
| Symbols    | Any number (rows in each table) |

You do **not** need:

- Separate tables per symbol (symbols are rows, not tables)
- Separate tables per symbol-timeframe combo

## Visual summary

```
┌─────────────────────────────────────────────────────────┐
│ ohlcv_1m (source of truth)                              │
│ ┌─────────┬─────────────────┬──────┬──────┬─────┬─────┐ │
│ │ symbol  │ ts              │ open │ high │ low │close│ │
│ ├─────────┼─────────────────┼──────┼──────┼─────┼─────┤ │
│ │ BTCUSDT │ 2024-01-15 10:00│ ...  │ ...  │ ... │ ... │ │
│ │ BTCUSDT │ 2024-01-15 10:01│ ...  │ ...  │ ... │ ... │ │
│ │ ETHUSD  │ 2024-01-15 10:00│ ...  │ ...  │ ... │ ... │ │
│ │ ETHUSD  │ 2024-01-15 10:01│ ...  │ ...  │ ... │ ... │ │
│ └─────────┴─────────────────┴──────┴──────┴─────┴─────┘ │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼ (backfill script calculates)
┌─────────────────────────────────────────────────────────┐
│ ohlcv_60m (calculated sliding window)                   │
│ ┌───────┬───────────┬─────┬──────┬──────┬─────┬───────┐ │
│ │symbol │ ts        │ idx │ open │ high │ ... │ rsi_14│ │
│ ├───────┼───────────┼─────┼──────┼──────┼─────┼───────┤ │
│ │BTCUSDT│ 10:00     │  1  │ agg  │ agg  │ ... │ 54.2  │ │
│ │BTCUSDT│ 10:01     │  2  │ agg  │ agg  │ ... │ 55.1  │ │
│ │BTCUSDT│ 10:02     │  3  │ agg  │ agg  │ ... │ 53.8  │ │
│ │ETHUSD │ 10:00     │  1  │ agg  │ agg  │ ... │ 48.7  │ │
│ │ETHUSD │ 10:01     │  2  │ agg  │ agg  │ ... │ 49.2  │ │
│ └───────┴───────────┴─────┴──────┴──────┴─────┴───────┘ │
└─────────────────────────────────────────────────────────┘
```
