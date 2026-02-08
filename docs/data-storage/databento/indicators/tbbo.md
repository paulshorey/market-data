## System Overview

This server streams TBBO (Trade-By-Order) data from Databento for futures contracts. Each trade includes price, volume, aggressor side, and order book snapshot. The system calculates order flow metrics and stores 1-minute candles in PostgreSQL.

## Database Schema

### Table: `candles-1m`

**Meta columns:**
| Column | Type | Description |
|--------|------|-------------|
| `time` | timestamp | Minute bucket (ISO format) |
| `ticker` | text | Short name (ES, GC, NQ) |
| `symbol` | text | Contract name (ESH6, GCJ6) |

**Price columns:**
| Column | Type | Description |
|--------|------|-------------|
| `open`, `high`, `low`, `close` | numeric | OHLC prices |
| `volume` | integer | Total contracts traded |

**Metric columns:** Each metric has 4 OHLC variants (`_open`, `_high`, `_low`, `_close`)

---

## Metrics Quick Reference

| Metric           | Formula                   | Range        | Key Signal                         |
| ---------------- | ------------------------- | ------------ | ---------------------------------- |
| `vd`             | askVol - bidVol           | unbounded    | +/- = buy/sell aggressive          |
| `cvd`            | running sum of vd         | unbounded    | Trend of accumulation              |
| `vd_ratio`       | vd / total classified vol | -1 to +1     | >0.3 or <-0.3 = significant        |
| `book_imbalance` | (bidDepth-askDepth)/total | -1 to +1     | >0 = support, <0 = resistance      |
| `divergence`     | price vs vd direction     | -1, 0, +1    | ≠0 = absorption detected           |
| `evr`            | price_pct / vd_ratio      | unbounded    | Low = absorption, High = efficient |
| `smp`            | composite score           | -100 to +100 | Institutional pressure direction   |
| `vd_strength`    | current/avg VD ratio      | 0.2 to 3.0   | >1.2 = accelerating                |
| `price_pct`      | price change in bps       | unbounded    | Normalized price movement          |
| `spread_bps`     | spread in bps             | >0           | ES typical: 0.36-0.42              |
| `vwap`           | vol-weighted avg price    | price        | Fair value for candle              |
| `trades`         | count of trades           | integer      | Activity level                     |
| `avg_trade_size` | volume / trades           | decimal      | Typical order size                 |
| `max_trade_size` | largest single trade      | integer      | Block trade detection              |
| `big_trades`     | count >= 25 contracts     | integer      | Institutional activity             |
| `big_volume`     | volume from big trades    | integer      | Institutional volume               |

**See `docs/strategy/metrics-guide.md` for detailed explanations.**

---

## Core Concepts

### Aggressive vs Passive Flow

- **Aggressive (VD):** Market orders that "lift the ask" (buy) or "hit the bid" (sell)
- **Passive (book_imbalance):** Limit orders waiting in the book

### Absorption Pattern

When VD shows aggressive buying but price doesn't go up (or goes down), passive sellers are absorbing the buying. This is **distribution** (bearish). The reverse is **accumulation** (bullish).

```
Absorption = High |VD| + Low EVR + divergence ≠ 0
```

### Momentum Pattern

When VD and price move together efficiently with no divergence.

```
Momentum = VD direction = price direction + divergence = 0 + high EVR
```

---

## 4 Pattern Detection Queries

Run: `npx tsx scripts/detect-patterns.ts ES`

| #   | Pattern                | Signal | Trigger                                           |
| --- | ---------------------- | ------ | ------------------------------------------------- |
| 1   | **Bearish Absorption** | SELL   | `divergence = -1`, `vd_ratio > 0`                 |
| 2   | **Bullish Absorption** | BUY    | `divergence = 1`, `vd_ratio < 0`                  |
| 3   | **Bullish Momentum**   | LONG   | `divergence = 0`, `vd_ratio > 0`, `price_pct > 0` |
| 4   | **Bearish Momentum**   | SHORT  | `divergence = 0`, `vd_ratio < 0`, `price_pct < 0` |

**See `docs/strategy/pattern-detection.md` for full SQL queries and interpretation.**

---

## Data Formats

### Historical TBBO (JSONL files)

Processed by `scripts/historical-tbbo.ts`. Files are JSONL (one JSON object per line).

**Databento format:**

```json
{
  "ts_recv": "2025-11-30T23:00:00.039Z",
  "hd": { "ts_event": "2025-11-30T23:00:00.000Z", "rtype": 1, "instrument_id": 42140878 },
  "action": "T",
  "side": "N",
  "price": "6913.500000000",
  "size": 1,
  "levels": [{ "bid_px": "6915.75", "ask_px": "6913.00", "bid_sz": 1, "ask_sz": 1 }],
  "symbol": "ESH6"
}
```

**Flat format:**

```json
{
  "timestamp": "2025-11-30T23:00:00.000Z",
  "symbol": "ESH6",
  "price": 6913.5,
  "size": 1,
  "side": "A",
  "bid_px": 6915.75,
  "ask_px": 6913.0,
  "bid_sz": 1,
  "ask_sz": 1
}
```

**Key fields:**

- `price`, `size`, `symbol` - Required trade data
- `side` - "A" (buy), "B" (sell), "N" (unknown → Lee-Ready algorithm)
- `bid_px`, `ask_px`, `bid_sz`, `ask_sz` - Book snapshot at trade time

**Note:** Spread contracts (symbols with "-" like "ESZ5-ESH6") are skipped.

### Real-time Streaming

Connected via `src/stream/tbbo-stream.ts`. Key differences from historical:

- Prices are fixed-point integers (multiply by `1e-9`)
- Symbol resolved via `instrument_id` mapping (rtype=22 messages)
- Timestamps are nanosecond epochs as strings

**Example streaming record:**

```json
{
  "hd": { "ts_event": "1769642638977303721", "instrument_id": 42140878 },
  "action": "T",
  "side": "B",
  "price": "7011000000000",
  "size": 1,
  "levels": [{ "bid_px": "7010750000000", "ask_px": "7011000000000", "bid_sz": 11, "ask_sz": 3 }]
}
```

**Parsed:** price = 7011.0, bid = 7010.75, ask = 7011.0

---

## Implementation Notes

### OHLC Metric Tracking

Each metric tracks Open/High/Low/Close within the candle:

- `_open` - Value at first trade
- `_high` - Maximum value reached
- `_low` - Minimum value reached
- `_close` - Value at last trade

### SMP Calculation Note

SMP OHLC values exclude the `divergence` component (calculated only at candle close). Use `smp_close` + `divergence` together for complete analysis.

### vd_strength for Historical Data

`vd_strength` requires rolling 5-minute history. For historical batch processing, it defaults to 1.0. Use other metrics for historical momentum analysis, or implement post-processing.

### Large Trade Thresholds

Based on CME block trade minimums:

- ES, NQ, CL, GC: 25 contracts
- Default: 25 contracts

---

## Common Queries

```sql
-- Recent absorption signals with institutional involvement
SELECT time, close, vd_ratio_close, divergence, big_trades, smp_close
FROM "candles-1m"
WHERE ticker = 'ES'
  AND divergence != 0
  AND big_trades > 0
ORDER BY time DESC
LIMIT 20;

-- Strong institutional buying
SELECT * FROM "candles-1m"
WHERE ticker = 'ES' AND smp_close > 50
ORDER BY time DESC LIMIT 20;

-- Momentum exhaustion setup
SELECT time, close, vd_ratio_close, vd_strength, smp_close
FROM "candles-1m"
WHERE ticker = 'ES'
  AND ABS(vd_ratio_close) > 0.3
  AND vd_strength < 0.7
ORDER BY time DESC;
```

---

## TODO

### Historical vd_strength

Implement rolling 5-minute history in `scripts/historical-tbbo.ts` to properly calculate `vd_strength` for historical data.

### Suggested Metrics

Read `docs/strategy/suggested-metrics.md` about metrics to implement:

- `cvd_slope` - CVD rate of change
- `volume_spike` - Volume vs recent average
- `absorption_intensity` - Normalized absorption score
- `delta_exhaustion` - Extreme delta followed by quiet
