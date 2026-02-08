# Calculating Indicators with Rolling Windows

This document explains how to calculate technical indicators (RSI, EMA, etc.) for higher-timeframe tables using the minute_index approach.

## Strategy

Each higher-timeframe table (e.g., `ohlcv_60m`) has rows for every minute, with `minute_index` cycling 0 to N-1. Rows with the same `minute_index` are spaced exactly N minutes apart, forming an independent time series suitable for indicator calculation.

```
For each minute_index (0 to 59) in parallel:
  1. Query: SELECT ts, close FROM ohlcv_60m
            WHERE symbol='ES' AND minute_index=X
            ORDER BY ts
  2. Stream through rows, feeding RSI calculator
  3. Collect updates in batches
  4. Bulk update via staging table + COPY
```

Each minute_index gets its own RSI calculator maintaining:
- Last price (for computing change)
- Average gain (Wilder's smoothed)
- Average loss (Wilder's smoothed)

The calculator needs ~100 bytes of state, so 60 parallel calculators use negligible memory.

## Why This Works

| Aspect | Benefit |
|--------|---------|
| Index usage | `WHERE symbol='ES' AND minute_index=X ORDER BY ts` uses the composite B-tree index |
| Data locality | Each query reads contiguous index pages |
| Batch updates | Staging table + COPY is 50-100x faster than individual UPDATEs |
| Parallelism | Multiple minute_index values process concurrently |
| HOT updates | Indicator columns are not indexed, so updates skip index maintenance |
| Transaction size | Each minute_index is a separate transaction (~1/60th of data) |

## Usage

```bash
# Calculate RSI for all minute_indexes with 4 parallel workers
npx tsx scripts/calculate-rsi.ts ES 60

# More parallelism
npx tsx scripts/calculate-rsi.ts ES 60 --parallelism 8

# Single minute_index (testing)
npx tsx scripts/calculate-rsi.ts ES 60 --minute-index 45

# Verify calculations
npx tsx scripts/calculate-rsi.ts ES 60 --verify --minute-index 0
```

## Reference Implementation

See [calculate-indicator-values.ts](./calculate-indicator-values.ts) for the full TypeScript implementation including:
- `RSICalculator` class using Wilder's Smoothing
- Streaming price data with cursor-based pagination
- `bulkUpdateRSI` using staging table + COPY
- Parallel worker pool processing all minute_indexes
- Verification mode to compare stored vs. calculated values
