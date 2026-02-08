# Summary of my Timescale DB

## Hypertable with columnstore

```
CREATE TABLE "candles-1m" (
    time TIMESTAMPTZ NOT NULL,
    ticker TEXT NOT NULL,
    open DOUBLE PRECISION NOT NULL,
    high DOUBLE PRECISION NOT NULL,
    low DOUBLE PRECISION NOT NULL,
    close DOUBLE PRECISION NOT NULL,
    volume DOUBLE PRECISION NOT NULL,
    symbol TEXT,
    -- Aggressive Order Flow (market orders)
    vd DOUBLE PRECISION,              -- Volume Delta: askVolume - bidVolume
    cvd DOUBLE PRECISION,             -- Cumulative Volume Delta (running total)
    vd_ratio DOUBLE PRECISION,        -- VD / classified volume, bounded -1 to +1
    -- Passive Order Flow (limit orders)
    book_imbalance DOUBLE PRECISION,  -- (bidDepth - askDepth) / total, bounded -1 to +1
    -- Price Metrics
    price_pct DOUBLE PRECISION,       -- Price change in basis points (100 = 1%)
    vwap DOUBLE PRECISION,            -- Volume-weighted average price
    -- Liquidity Metrics
    spread_bps DOUBLE PRECISION,      -- Average spread in basis points
    -- Activity Metrics
    trades INTEGER,                   -- Number of trades in candle
    avg_trade_size DOUBLE PRECISION,  -- Average size per trade (volume/trades)
    -- Large Trade Detection
    max_trade_size DOUBLE PRECISION,  -- Largest single trade in candle
    big_trades INTEGER,               -- Count of trades >= large threshold
    big_volume DOUBLE PRECISION,      -- Total volume from large trades
    -- Absorption Detection
    divergence SMALLINT,              -- 1=bullish, -1=bearish, 0=none
    evr DOUBLE PRECISION,             -- Effort vs Result absorption score
    -- Composite Score
    smp SMALLINT,                     -- Smart Money Pressure (-100 to +100)
    -- Momentum
    vd_strength DOUBLE PRECISION,     -- Current VD vs 5-min average (>1 = accelerating)
    PRIMARY KEY (ticker, time)
);

SELECT create_hypertable('candles-1m', by_range('time', INTERVAL '1 month'));

-- Enable compression
ALTER TABLE "candles-1m" SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'ticker',
    timescaledb.compress_orderby = 'time DESC'
);

SELECT add_compression_policy('candles-1m', INTERVAL '1 month');
```

### Migration: Adding Order Flow Columns

For existing deployments, add the order flow columns with the following statements:

```sql
-- Aggressive order flow
ALTER TABLE "candles-1m" ADD COLUMN IF NOT EXISTS vd DOUBLE PRECISION;
ALTER TABLE "candles-1m" ADD COLUMN IF NOT EXISTS cvd DOUBLE PRECISION;
ALTER TABLE "candles-1m" ADD COLUMN IF NOT EXISTS vd_ratio DOUBLE PRECISION;

-- Passive order flow
ALTER TABLE "candles-1m" ADD COLUMN IF NOT EXISTS book_imbalance DOUBLE PRECISION;

-- Price metrics
ALTER TABLE "candles-1m" ADD COLUMN IF NOT EXISTS price_pct DOUBLE PRECISION;
ALTER TABLE "candles-1m" ADD COLUMN IF NOT EXISTS vwap DOUBLE PRECISION;

-- Liquidity metrics
ALTER TABLE "candles-1m" ADD COLUMN IF NOT EXISTS spread_bps DOUBLE PRECISION;

-- Activity metrics
ALTER TABLE "candles-1m" ADD COLUMN IF NOT EXISTS trades INTEGER;
ALTER TABLE "candles-1m" ADD COLUMN IF NOT EXISTS avg_trade_size DOUBLE PRECISION;

-- Large trade detection
ALTER TABLE "candles-1m" ADD COLUMN IF NOT EXISTS max_trade_size DOUBLE PRECISION;
ALTER TABLE "candles-1m" ADD COLUMN IF NOT EXISTS big_trades INTEGER;
ALTER TABLE "candles-1m" ADD COLUMN IF NOT EXISTS big_volume DOUBLE PRECISION;

-- Absorption detection
ALTER TABLE "candles-1m" ADD COLUMN IF NOT EXISTS divergence SMALLINT;
ALTER TABLE "candles-1m" ADD COLUMN IF NOT EXISTS evr DOUBLE PRECISION;

-- Composite score
ALTER TABLE "candles-1m" ADD COLUMN IF NOT EXISTS smp SMALLINT;

-- Momentum
ALTER TABLE "candles-1m" ADD COLUMN IF NOT EXISTS vd_strength DOUBLE PRECISION;

-- If migrating from old schema with momentum column, drop it
ALTER TABLE "candles-1m" DROP COLUMN IF EXISTS momentum;
```

**Note on compressed chunks:** If you have compressed chunks, you may need to decompress them before adding columns, then recompress:

```sql
-- Check for compressed chunks
SELECT show_chunks('candles-1m', older_than => INTERVAL '1 month');

-- If needed, decompress specific chunks before altering
SELECT decompress_chunk('<chunk_name>');

-- After adding columns, recompress
SELECT compress_chunk('<chunk_name>');
```

Alternatively, for large tables with many compressed chunks, consider:
1. Creating a new table with the updated schema
2. Migrating data in batches
3. Renaming tables

### Index to extract times

```
CREATE INDEX idx_minute ON "candles-1m" ((EXTRACT(MINUTE FROM time AT TIME ZONE 'UTC')));
CREATE INDEX idx_hour ON "candles-1m" ((EXTRACT(HOUR FROM time AT TIME ZONE 'UTC')));
CREATE INDEX idx_dow ON "candles-1m" ((EXTRACT(DOW FROM time AT TIME ZONE 'UTC')));
```

To query these extracted columns:

```
SELECT * FROM "candles-1m"
WHERE ticker = 'ES'
AND EXTRACT(HOUR FROM time) = 14
AND EXTRACT(MINUTE FROM time) = 30;
```

### Note on using extracted times

For Crypto markets all hour/dow are valid.
For Futures however, some will be missing.

1. Holidays - usually not the full 24 hours missing, but only closed part of the day
   - don't think there's anything we can do, hour/dow will be skiped
2. Market close - between 16-17 daily
   - avoid querying for hour=16 (17:00 should be fine, 15:59 should be fine)
3. Weekend - between 16 Friday to 17 Sunday
   - avoid querying dow for 6 (Saturday)
   - when choosing dow 5 or 0, be careful about market close hours

Example query to get weekly prices:

```
SELECT * FROM "candles-1m"
WHERE ticker = 'ES'
AND EXTRACT(DOW FROM time) = 5
AND EXTRACT(HOUR FROM time) = 14
AND EXTRACT(MINUTE FROM time) = 59;
```

### Aggregated candles

Hour:

```
SELECT
    time_bucket('1 hour', time) AS time,
    ticker,
    first(open, time) AS open,
    max(high) AS high,
    min(low) AS low,
    last(close, time) AS close,
    sum(volume) AS volume
FROM "candles-1m"
WHERE ticker = 'ES'
GROUP BY time_bucket('1 hour', time), ticker
ORDER BY time;
```

This converts 60 one-minute rows into 1 one-hour row.
Pre-compute this by telling TimescaleDB to aggregate hour/day/week candles every time a new minute row is added.

Setting Up Continuous Aggregates:

```
CREATE MATERIALIZED VIEW candles_1h
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', time) AS time,
    ticker,
    first(open, time) AS open,
    max(high) AS high,
    min(low) AS low,
    last(close, time) AS close,
    sum(volume) AS volume
FROM "candles-1m"
GROUP BY time_bucket('1 hour', time), ticker
WITH NO DATA;

CREATE MATERIALIZED VIEW candles_1d
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 day', time) AS time,
    ticker,
    first(open, time) AS open,
    max(high) AS high,
    min(low) AS low,
    last(close, time) AS close,
    sum(volume) AS volume
FROM candles_1h
GROUP BY time_bucket('1 day', time), ticker
WITH NO DATA;

CREATE MATERIALIZED VIEW candles_1w
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 week', time) AS time,
    ticker,
    first(open, time) AS open,
    max(high) AS high,
    min(low) AS low,
    last(close, time) AS close,
    sum(volume) AS volume
FROM candles_1d
GROUP BY time_bucket('1 week', time), ticker
WITH NO DATA;
```

Populating the aggregates with existing data:

```
CALL refresh_continuous_aggregate('candles_1h', NULL, NULL);
CALL refresh_continuous_aggregate('candles_1d', NULL, NULL);
CALL refresh_continuous_aggregate('candles_1w', NULL, NULL);
```

For ongoing updates, add automatic refresh policies:

```
SELECT add_continuous_aggregate_policy('candles_1h',
    start_offset => INTERVAL '3 hours',
    end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 hour'
);

SELECT add_continuous_aggregate_policy('candles_1d',
    start_offset => INTERVAL '3 days',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 day'
);

SELECT add_continuous_aggregate_policy('candles_1w',
    start_offset => INTERVAL '3 weeks',
    end_offset => INTERVAL '1 day',
    schedule_interval => INTERVAL '1 day'
);
```

### Querying aggregated candles

```
SELECT * FROM candles_1h
WHERE ticker = 'ES'
AND time >= '2024-01-01' AND time < '2024-02-01';

SELECT * FROM candles_1d
WHERE ticker = 'ES'
AND time >= '2023-01-01';

SELECT * FROM candles_1w
WHERE ticker = 'ES';

SELECT time, ticker, volume
FROM candles_1w
WHERE time >= '2024-01-01'
ORDER BY time, volume DESC;
```

### Deleting views

```
DROP MATERIALIZED VIEW oldtable_1w;
DROP MATERIALIZED VIEW oldtable_1d;
DROP MATERIALIZED VIEW oldtable_1h;
DROP TABLE "oldtable-1m";
```

or use CASCADE to drop the table and everything that depends on it

```
DROP TABLE "oldtable-1m" CASCADE;
```

## Create any combination of minutes into custom timeframes

```
CREATE MATERIALIZED VIEW candles_181m
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('181 minutes', time) AS time,
    ticker,
    first(open, time) AS open,
    max(high) AS high,
    min(low) AS low,
    last(close, time) AS close,
    sum(volume) AS volume
FROM "candles-1m"
GROUP BY time_bucket('181 minutes', time), ticker
WITH NO DATA;

SELECT add_continuous_aggregate_policy('candles_181m',
    start_offset => INTERVAL '543 minutes',  -- 3 periods back
    end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '181 minutes'
);
```

I have created views and continuous aggregate policy for several custom intervals.

Whenever rows are inserted, the database will automatically aggregate minutes into higher timeframe buckets.

## After adding data, run aggregation

All aggregated timeframes:

```
CALL refresh_continuous_aggregate('candles_1h', NULL, NULL);
CALL refresh_continuous_aggregate('candles_1d', NULL, NULL);
CALL refresh_continuous_aggregate('candles_1w', NULL, NULL);
CALL refresh_continuous_aggregate('candles_109m', NULL, NULL);
CALL refresh_continuous_aggregate('candles_13m', NULL, NULL);
CALL refresh_continuous_aggregate('candles_181m', NULL, NULL);
CALL refresh_continuous_aggregate('candles_29m', NULL, NULL);
CALL refresh_continuous_aggregate('candles_3m', NULL, NULL);
CALL refresh_continuous_aggregate('candles_59m', NULL, NULL);
CALL refresh_continuous_aggregate('candles_5m', NULL, NULL);
CALL refresh_continuous_aggregate('candles_7m', NULL, NULL);
```
