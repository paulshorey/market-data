# Sliding Window Technical Indicator Platform

To start, we'll stick with the classic RSI indicator. After that is successfully implemented, we'll add other algorithms.

Calculate higher-timeframe technical indicators (RSI, etc.) at 1-minute resolution using sliding windows.

## The Problem

Standard time-series aggregation produces **tumbling windows**: one output per period (e.g., one hourly candle per hour).

This platform produces **sliding windows**: one output per minute, where each row represents the aggregated data over the preceding N minutes. This enables:

- Smooth, high-resolution charting
- Precise backtesting at any point in time
- Technical indicators that update every minute, not once per timeframe

## Architecture

All tables share the **same schema**, enabling uniform queries across all timeframes:

```
┌─────────────────────────────────────────────────────────┐
│ ohlcv_1m (source of truth + indicators)                 │
│ minute_index = 1 (always)                               │
│ OHLCV = raw market data                                 │
│ rsi_14 = calculated from raw closes                     │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ ohlcv_60m (calculated from ohlcv_1m)                    │
│ minute_index = 1-60 (cycling)                           │
│ OHLCV = aggregated over past 60 minutes                 │
│ rsi_14 = calculated from aggregated closes              │
└─────────────────────────────────────────────────────────┘

All tables have identical columns:
symbol, ts, minute_index, open, high, low, close, volume, window_complete, rsi_14, ...
```

**Same query works on any timeframe:**

```sql
SELECT ts, open, high, low, close, rsi_14
FROM ohlcv_60m  -- or ohlcv_1m, ohlcv_1440m, etc.
WHERE symbol = 'BTCUSDT' AND ts >= NOW() - INTERVAL '7 days'
ORDER BY ts;
```

## The minute_index Trick

For RSI-14 on a 60-minute timeframe, we need 14 "complete" hourly candles. But we have a row for every minute!

The `minute_index` column cycles 1 → 60 → 1 → 60...

- minute_index=1: rows at 10:00, 11:00, 12:00... (each 60 mins apart)
- minute_index=2: rows at 10:01, 11:01, 12:01... (each 60 mins apart)

To get 14 hourly candles for RSI at 10:30 (minute_index=31):

```sql
SELECT close FROM ohlcv_60m
WHERE symbol = 'BTCUSDT' AND minute_index = 31
ORDER BY ts DESC LIMIT 14;
```

This returns: 10:30, 9:30, 8:30, 7:30... — exactly what we need!

## Key Insight: One RSI Calculator Per minute_index

RSI with Wilder's smoothing is **sequential** — each value depends on the previous. But the RSI at minute_index=2 doesn't depend on minute_index=1, it uses previous rows with the same minute_index.

1. Indicator starting at 10:01 (minute_index=1) calculatest based on previous values at 9:01, 8:01, 7:01, 6:01, etc.
2. Indicator starting at 10:02 (minute_index=2) calculatest based on previous values at 9:02, 8:02, 7:02, 6:02, etc.
3. Indicator starting at 10:03 (minute_index=3) calculatest based on previous values at 9:03, 8:03, 7:03, 6:03, etc.

So we maintain **60 independent RSI calculators** for a 60-minute timeframe, one per minute_index. Each has its own smoothed average state.

## Files

```
indicators/
├── package.json
├── README.md
├── sql/
│   └── setup.sql          # Database schema
└── src/
    ├── indicators.js      # RSI calculator, sliding window
    ├── backfill.js        # Historical calculation
    ├── realtime.js        # Live updates
    └── test.js            # Verification tests
```

## Setup

1. **Create the database tables:**

```bash
psql -d your_database -f sql/setup.sql
```

2. **Install dependencies:**

```bash
npm install
```

3. **Configure database connection:**

```bash
export DB_HOST=localhost
export DB_PORT=5432
export DB_NAME=trading
export DB_USER=postgres
export DB_PASSWORD=yourpassword
```

## Usage

### Run Tests

Verify RSI calculation accuracy:

```bash
npm test
# or
node src/test.js
```

### Historical Backfill

Calculate all historical data for a timeframe:

```bash
# 1-minute: calculates indicators only (no OHLCV aggregation)
node src/backfill.js 1

# All symbols, 60-minute timeframe
node src/backfill.js 60

# Single symbol
node src/backfill.js 60 BTCUSDT

# Other timeframes
node src/backfill.js 15    # 15-minute
node src/backfill.js 240   # 4-hour
node src/backfill.js 1440  # Daily
```

### Real-time Updates

Keep indicators up-to-date as new candles arrive:

```bash
# Polling mode (checks every 5 seconds)
node src/realtime.js 60

# Event-driven mode (uses PostgreSQL LISTEN/NOTIFY)
node src/realtime.js 60 --event-driven
```

## Database Schema

### Unified Schema (All Timeframes)

Every table—from 1-minute to 1-day—uses the same schema:

```sql
CREATE TABLE ohlcv_<N>m (
    symbol          VARCHAR(20) NOT NULL,
    ts              TIMESTAMPTZ NOT NULL,
    minute_index    SMALLINT NOT NULL,  -- Cycles 1-N (always 1 for 1m)
    open            NUMERIC(18,8),
    high            NUMERIC(18,8),
    low             NUMERIC(18,8),
    close           NUMERIC(18,8),
    volume          NUMERIC(24,8),
    window_complete BOOLEAN,            -- Is the aggregation window full?
    rsi_14          NUMERIC(8,4),       -- Indicators...
    -- Add more indicator columns as needed
    PRIMARY KEY (symbol, ts)
);

-- Critical index for minute_index queries
CREATE INDEX idx_ohlcv_<N>m_indicator_lookup
    ON ohlcv_<N>m (symbol, minute_index, ts DESC);
```

### Key Differences by Timeframe

| Timeframe | minute_index  | OHLCV Data              | RSI Calculators |
| --------- | ------------- | ----------------------- | --------------- |
| 1m        | Always 1      | Raw market data         | 1               |
| 60m       | Cycles 1-60   | Aggregated over 60 mins | 60              |
| 1440m     | Cycles 1-1440 | Aggregated over 1 day   | 1440            |

## Adding More Indicators

1. Add a column to the table:

```sql
ALTER TABLE ohlcv_60m ADD COLUMN ema_21 NUMERIC(18,8);
```

2. Create a calculator class in `indicators.js` (similar to `RSICalculator`)

3. Update `backfill.js` to maintain calculator state and write values

## RSI Calculation Details

This implementation uses **Wilder's Smoothing** (the original RSI formula):

```
First Average Gain = Sum of Gains over past 14 periods / 14
First Average Loss = Sum of Losses over past 14 periods / 14

Subsequent values:
Average Gain = ((Previous Avg Gain * 13) + Current Gain) / 14
Average Loss = ((Previous Avg Loss * 13) + Current Loss) / 14

RS = Average Gain / Average Loss
RSI = 100 - (100 / (1 + RS))
```

This is equivalent to an EMA with α = 1/14, but the initialization differs.

## Performance Notes

- **Backfill**: Processes ~10,000-50,000 rows/second depending on hardware
- **Indexes**: The `(symbol, minute_index, ts DESC)` index makes indicator queries instant
- **Memory**: Each symbol state uses ~1KB per timeframe (sliding window + RSI states)
- **Storage**: Same row count as 1-minute table, but with extra columns

## Common Patterns

### Query recent RSI values for charting

```sql
SELECT ts, close, rsi_14
FROM ohlcv_60m
WHERE symbol = 'BTCUSDT'
  AND ts >= NOW() - INTERVAL '7 days'
ORDER BY ts DESC;
```

### Query aligned candles for new indicator calculation

```sql
-- Get 14 hourly candles ending at the current minute_index
SELECT ts, open, high, low, close, volume
FROM ohlcv_60m
WHERE symbol = 'BTCUSDT'
  AND minute_index = 31  -- Current minute in the hour
ORDER BY ts DESC
LIMIT 14;
```

### Backtest query (all data for a date range)

```sql
SELECT *
FROM ohlcv_60m
WHERE symbol = 'BTCUSDT'
  AND ts BETWEEN '2024-01-01' AND '2024-06-01'
ORDER BY ts;
```

## Limitations

- **Incomplete windows**: First N-1 rows after market open have partial data (`window_complete = false`)
- **Sequential indicators**: RSI/EMA require chronological processing; can't parallelize across time
- **Storage**: 10 timeframes = 10× the storage of the 1-minute table

---

## Backtesting Framework

The backtesting engine is designed for **high-performance, multi-timeframe analysis** at scale.

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      BacktestEngine                             │
│                                                                 │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐               │
│  │ Buffer 1m   │ │ Buffer 60m  │ │ Buffer 1440m│  ...          │
│  │ [5K window] │ │ [5K window] │ │ [5K window] │               │
│  │ [50K buffer]│ │ [50K buffer]│ │ [50K buffer]│               │
│  └─────────────┘ └─────────────┘ └─────────────┘               │
│                            │                                    │
│                            ▼                                    │
│                   ┌─────────────────┐                          │
│                   │ Your Strategy   │                          │
│                   │ Function        │                          │
│                   └─────────────────┘                          │
└─────────────────────────────────────────────────────────────────┘
```

### Memory Efficiency

Instead of loading millions of rows into memory, the engine uses **chunked streaming**:

| Component                    | Size      | Memory     |
| ---------------------------- | --------- | ---------- |
| Window (5,000 bars × 10 tf)  | 50K rows  | ~5 MB      |
| Buffer (50,000 bars × 10 tf) | 500K rows | ~50 MB     |
| **Total**                    |           | **~55 MB** |

Data is loaded in chunks as the backtest progresses. Old data is trimmed to maintain constant memory usage.

### Performance

Expected throughput: **50,000-200,000 bars/second** depending on strategy complexity.

| Dataset             | Approximate Time |
| ------------------- | ---------------- |
| 1 year (500K bars)  | 3-10 seconds     |
| 5 years (2.5M bars) | 15-50 seconds    |
| 10 years (5M bars)  | 30-100 seconds   |

### Usage

```bash
node src/backtest/run.js BTCUSDT 2024-01-01 2024-06-01
```

### Writing Strategies

```javascript
function myStrategy(ctx) {
  // Access any timeframe
  const tf1h = ctx.tf(60); // 1-hour
  const tf4h = ctx.tf(240); // 4-hour
  const tf1d = ctx.tf(1440); // Daily

  // Get current bar
  const current = tf1h.current();
  // { ts, open, high, low, close, volume, rsi14, ... }

  // Get previous bars
  const prev = tf1h.get(1); // 1 bar ago
  const prev5 = tf1h.get(5); // 5 bars ago

  // Get series for calculations
  const closes = tf1h.series("close", 20); // Last 20 closes
  const rsiValues = tf1h.series("rsi14", 14);

  // Check position
  if (ctx.position === 0) {
    // Not in a trade
  }

  // Place orders
  ctx.buy(1); // Buy 1 unit at market
  ctx.sell(1); // Sell 1 unit at market
  ctx.close(); // Close entire position

  // Logging
  ctx.log("RSI:", current.rsi14);
}
```

### Multi-Timeframe Example

```javascript
function multiTfStrategy(ctx) {
  const rsi1h = ctx.tf(60).current().rsi14;
  const rsi4h = ctx.tf(240).current().rsi14;
  const rsi1d = ctx.tf(1440).current().rsi14;

  // Require alignment across all timeframes
  const allOversold = rsi1h < 30 && rsi4h < 35 && rsi1d < 40;
  const anyOverbought = rsi1h > 70 || rsi4h > 70 || rsi1d > 70;

  if (allOversold && ctx.position === 0) {
    ctx.buy(1);
  }

  if (anyOverbought && ctx.position > 0) {
    ctx.close();
  }
}
```

### API Reference

**Context object (`ctx`):**

| Property/Method     | Description                                     |
| ------------------- | ----------------------------------------------- |
| `ctx.time`          | Current bar timestamp                           |
| `ctx.tf(minutes)`   | Get timeframe accessor                          |
| `ctx.current`       | Shorthand for smallest timeframe's current bar  |
| `ctx.position`      | Current position size (+ long, - short, 0 flat) |
| `ctx.positionPrice` | Average entry price                             |
| `ctx.capital`       | Available capital                               |
| `ctx.equity`        | Capital + unrealized P&L                        |
| `ctx.buy(qty)`      | Place buy order                                 |
| `ctx.sell(qty)`     | Place sell order                                |
| `ctx.close()`       | Close entire position                           |
| `ctx.log(...)`      | Log message with timestamp                      |

**Timeframe accessor (`ctx.tf(60)`):**

| Method                   | Description               |
| ------------------------ | ------------------------- |
| `.current()`             | Get current bar           |
| `.get(n)`                | Get bar N periods ago     |
| `.series(field, length)` | Get array of field values |
| `.window()`              | Get full 5,000-bar window |

## License

MIT
