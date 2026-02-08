# Backtesting Engine: In-Memory Architecture

How to iterate through millions of minutes across multiple timeframes with a user's strategy function, while maintaining a 5,000-bar lookback window per timeframe.

## The Challenge

A backtest iterates through ~5 million minutes. At each step, the user's strategy needs access to:
- The last 5,000 bars of each timeframe (10 timeframes = 50,000 data points)
- All OHLCV + indicator fields for each bar

The strategy function runs ~5 million times. Each invocation must be fast.

## Architecture

### 1. Pre-load data into typed arrays

Use `Float64Array` buffers (one per column, per timeframe) instead of arrays of objects. This cuts memory 3-5x and improves iteration speed due to cache locality.

```js
const timeframes = {
  '1m':  {
    open:   new Float64Array(5_000_000),
    high:   new Float64Array(5_000_000),
    low:    new Float64Array(5_000_000),
    close:  new Float64Array(5_000_000),
    volume: new Float64Array(5_000_000),
  },
  '5m':  { /* same structure, fewer rows */ },
  // ...
};
```

`Float64Array` uses exactly 8 bytes per element with zero object overhead. 5M x 10 timeframes x 5 fields = ~2 GB.

### 2. Sliding window via index math

Never `shift()` and `push()` on arrays. That's O(n) copying. Instead, maintain an index pointer:

```js
let currentIndex = 5000;

for (let i = 5000; i < totalMinutes; i++) {
  const window = {
    get(field, barsAgo) {
      return timeframes['1m'][field][i - barsAgo];
    },
  };
  userStrategy(window);
}
```

Each iteration is essentially free -- no memory allocation, no copying, no GC pressure. Just incrementing an integer.

### 3. Chunked database loading

Load in chunks of 100k-500k rows per timeframe using a streaming cursor or paginated query. Write directly into pre-allocated `Float64Array` buffers as rows stream in.

```sql
SELECT ts, open, high, low, close, volume
FROM ohlcv_1m
WHERE symbol = 'ES'
ORDER BY ts
LIMIT 500000 OFFSET ?
```

### 4. Higher timeframe data access

The higher timeframe tables already store data at 1-minute resolution (rolling windows). Load them the same way as 1m data -- one row per minute, forward-filled values. This uses more memory but simplifies access patterns.

## Expected Performance

| Operation | Speed |
|-----------|-------|
| Iterating 5M indices with simple math | ~50-100ms |
| Accessing typed array elements per iteration | <1ns each |
| User strategy with ~50 indicator lookups per bar | ~1-5 seconds for 5M bars |
| Loading 500k rows from PostgreSQL | ~1-3 seconds |
| Total memory for 5M x 10 TF x 5 fields | ~2 GB |

The bottleneck will be the user's strategy complexity, not data access.

## Data Flow

```
┌─────────────────────────────────────┐
│     PostgreSQL (ohlcv_1m, etc.)     │
└──────────────┬──────────────────────┘
               │ Stream in chunks of 500k rows
               ▼
┌─────────────────────────────────────┐
│     Pre-allocated Float64Arrays     │
│  Per timeframe, per OHLCV column    │
│  (~2 GB for full dataset)           │
└──────────────┬──────────────────────┘
               │ Index pointer (zero-copy sliding window)
               ▼
┌─────────────────────────────────────┐
│     Strategy Execution Loop         │
│  for (i = 5000; i < N; i++) {      │
│    userStrategy(windowProxy(i));    │
│  }                                  │
└──────────────┬──────────────────────┘
               │
               ▼
        Trade log / results
```

## Reference Implementation

See [../data-indicators/rsi/](../data-indicators/rsi/) for a working implementation with `BacktestEngine.js` and `TimeframeBuffer.js` that implements this architecture with chunked streaming and 5,000-bar windows.
