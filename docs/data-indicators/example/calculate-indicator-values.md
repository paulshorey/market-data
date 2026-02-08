## How It Works

### Processing Strategy

```
For each minute_index (0 to 59) in parallel:
  1. Query: SELECT timestamp, close FROM ohlcv_60m
            WHERE symbol='ES' AND minute_index=X
            ORDER BY timestamp
  2. Stream through rows, feeding RSI calculator
  3. Collect updates in batches
  4. Bulk update via staging table + COPY
```

### RSI Calculator State Per Minute Index

Each `minute_index` gets its own RSI calculator that maintains:

- Last price (for computing change)
- Average gain (Wilder's smoothed)
- Average loss (Wilder's smoothed)

The calculator only needs ~100 bytes of state, so 60 parallel calculators use negligible memory.

### Why This Is Efficient

| Aspect           | Benefit                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| Index usage      | `WHERE symbol='ES' AND minute_index=X ORDER BY timestamp` uses the composite B-tree index perfectly |
| Data locality    | Each query reads contiguous index pages                                                             |
| Batch updates    | Staging table + COPY is 50-100x faster than individual UPDATEs                                      |
| Parallelism      | Multiple minute_index values process concurrently                                                   |
| HOT updates      | `rsi_14` column is not indexed, so updates don't touch indexes                                      |
| Transaction size | Each minute_index is a separate transaction (~1/60th of data)                                       |

---

## Usage

```bash
# Calculate RSI for all minute_indexes with 4 parallel workers
npx ts-node scripts/calculate-rsi.ts ES 60

# Use more parallelism on a powerful machine
npx ts-node scripts/calculate-rsi.ts ES 60 --parallelism 8

# Process just one minute_index (for testing)
npx ts-node scripts/calculate-rsi.ts ES 60 --minute-index 45

# Verify calculations match expected values
npx ts-node scripts/calculate-rsi.ts ES 60 --verify --minute-index 0

# Use a different RSI period
npx ts-node scripts/calculate-rsi.ts ES 60 --rsi-period 21
```

---

## Expected Output

```
======================================================================
Calculating RSI(14) for ES in ohlcv_60m
======================================================================

Minute index range: 0 to 59

Processing 60 minute indexes with parallelism=4

[Worker 0] minute_index=  0 | processed=  42,845 | updated=  42,831 | skipped= 14 | 1823ms | 1.7% complete
[Worker 1] minute_index=  1 | processed=  42,843 | updated=  42,829 | skipped= 14 | 1856ms | 3.3% complete
[Worker 2] minute_index=  2 | processed=  42,841 | updated=  42,827 | skipped= 14 | 1901ms | 5.0% complete
[Worker 3] minute_index=  3 | processed=  42,839 | updated=  42,825 | skipped= 14 | 1834ms | 6.7% complete
...

======================================================================
RSI Calculation Complete
======================================================================
Table:            ohlcv_60m
Symbol:           ES
RSI Period:       14
Minute Indexes:   60
Parallelism:      4
Total Processed:  2,570,340
Total Updated:    2,569,500
Total Skipped:    840 (warmup period)
Total Time:       45.3 seconds
Throughput:       56,738 rows/sec

Running ANALYZE on ohlcv_60m...
Statistics updated.
```

---

## Verification Output

```bash
npx ts-node scripts/calculate-rsi.ts ES 60 --verify --minute-index 0
```

```
Verification for ES minute_index=0:
------------------------------------------------------------
Timestamp                    | Close     | RSI_14
------------------------------------------------------------
2014-01-02T14:30:00.000Z |   1835.50 |   NULL (calc: NULL) ✓
2014-01-02T15:30:00.000Z |   1836.25 |   NULL (calc: NULL) ✓
...
2014-01-02T23:30:00.000Z |   1842.00 |   NULL (calc: NULL) ✓
2014-01-03T00:30:00.000Z |   1843.50 |  58.33 (calc: 58.33) ✓
2014-01-03T01:30:00.000Z |   1841.25 |  52.17 (calc: 52.17) ✓
2014-01-03T02:30:00.000Z |   1844.00 |  55.89 (calc: 55.89) ✓
```
