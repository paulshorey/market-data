# Question:

## Backtesting Framework Architecture: Data Processing at Scale

When running analysis on multiple timeframes across the entire available dataset, we'll need a script that iterates through every minute of each table from the beginning. Since users may want to combine logic from multiple timeframes and compare them against each other, running the script on each table independently won't be sufficient.

### The Core Challenge

How can we run an indicator or strategy script on millions of minutes across multiple tables while making all timeframes available to that script?

Not all data points need to be available at all times. TradingView allows looking back at the past 5,000 bars for each timeframe. QuantConnect uses something similar, though with a smaller number. Let's use TradingView as the standard since it offers the highest lookback.

This means allowing the user's strategy to access the past 5,000 items in each timeframe array. With 10 timeframes, that's 5,000 × 10 = 50,000 data points. That doesn't seem problematic—any JavaScript engine, whether browser or server-side, can process 50,000 data points nearly instantly.

### Architecture Considerations

The real challenge is structuring the architecture, logic, database queries, and server memory allocation to support a rolling, sliding window of 5,000 data points across 10 different JavaScript arrays—incremented approximately 5 million times.
At the start of the available data, we would skip forward 5,000 minutes and begin there. At that point, we'd have 10 arrays of 5,000 items for the user's strategy to evaluate. After their strategy function processes that state, we add the next minute and run the function again. Then the next, and the next—roughly 5 million times.

---

# Answer:

## Recommended Architecture

### 1. Pre-load all data into typed arrays, not objects

This is the single biggest optimization. Instead of arrays of objects like `[{open: 1.23, high: 1.24, ...}, ...]`, use `Float64Array` buffers — one per column, per timeframe:

```js
const timeframes = {
  "1m": {
    open: new Float64Array(5_000_000),
    high: new Float64Array(5_000_000),
    low: new Float64Array(5_000_000),
    close: new Float64Array(5_000_000),
    volume: new Float64Array(5_000_000),
  },
  "5m": {
    /* same structure, fewer rows */
  },
  // ...
};
```

`Float64Array` uses exactly 8 bytes per element with zero object overhead. Now your 5M × 10 timeframes × 5 fields = **~2 GB** actual memory. Very manageable.

### 2. Sliding window via index math, not array mutation

Never `shift()` and `push()` on arrays. That's O(n) copying. Instead, maintain an index pointer:

```js
let currentIndex = 5000; // start after initial lookback

// The user's strategy sees:
// close[currentIndex - 4999] through close[currentIndex]
// That's just pointer arithmetic — zero data copying.

for (let i = 5000; i < totalMinutes; i++) {
  const window = {
    get(field, barsAgo) {
      return timeframes["1m"][field][i - barsAgo];
    },
  };
  userStrategy(window);
}
```

This makes each iteration essentially free — no memory allocation, no copying, no garbage collection pressure. You're just incrementing an integer.

### 3. Bulk load from the database in large chunks

Don't load all 5M rows at once, and don't load one at a time. Load in chunks of **100k–500k rows** per timeframe using a streaming cursor or paginated queries:

```sql
SELECT timestamp, open, high, low, close, volume
FROM candles_1m
ORDER BY timestamp
LIMIT 500000 OFFSET ?
```

Or better, use a streaming query (e.g., `pg-cursor` for PostgreSQL) so you're not holding two copies in memory during the transfer. Write directly into your pre-allocated `Float64Array` buffers as rows stream in.

### 4. Pre-compute higher timeframe mappings

This is a critical design decision. Your higher timeframe tables (5m, 15m, 1h, etc.) have one row per minute but the values only change at the boundary. You have two options:

- **Option A**: Store a mapping array `minuteToHTFIndex[i]` that maps each 1-minute index to the corresponding index in the higher timeframe's "completed bar" array. This is a simple integer lookup.
- **Option B**: Just store the higher timeframe data at 1-minute resolution with forward-filled values (which it sounds like you're already doing). This uses more memory but simplifies access patterns enormously.

Option B is simpler and the memory cost is acceptable with typed arrays.

### 5. Benchmarks you can expect

On a modern machine with Node.js:

| Operation                                             | Speed                        |
| ----------------------------------------------------- | ---------------------------- |
| Iterating 5M indices with simple math                 | ~50–100ms                    |
| Accessing typed array elements per iteration          | <1ns each                    |
| User strategy with ~50 indicator lookups per bar      | ~1–5 seconds for full 5M run |
| Loading 500k rows from PostgreSQL                     | ~1–3 seconds                 |
| Total memory for 5M × 10 TF × 5 fields (Float64Array) | ~2 GB                        |

The bottleneck will almost certainly be the **user's strategy complexity**, not data access.

### 6. What I'd actually build

```
┌─────────────────────────────────────┐
│           PostgreSQL / SQLite       │
│  (candles_1m, candles_5m, etc.)     │
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

### Key Takeaways

- **Use `Float64Array`**, not JS objects. This alone cuts memory 3–5x and improves iteration speed dramatically due to cache locality.
- **Never copy or mutate arrays** during the loop. Use index arithmetic for the sliding window.
- **Load in large chunks** (100k–500k rows), not one-by-one and not all-at-once.
- **PostgreSQL or even SQLite** is fine for this. The DB is just a loading mechanism — all real work happens in memory.
- 5 million iterations with typed array access is trivially fast. The architecture you're describing is very achievable in Node.js.
