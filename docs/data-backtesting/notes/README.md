# Order Flow Trading Strategy

This documentation covers the order flow analysis strategy for detecting institutional activity, absorption, and momentum in futures markets using TBBO (Trade-By-Order) data.

**Implementation status:** The order flow metrics described here are fully implemented in `src/lib/metrics/`. The pattern detection logic is in `scripts/detect-patterns.ts`.

## Overview

Our strategy analyzes the relationship between **aggressive order flow** (market orders) and **passive order flow** (limit orders in the book) to detect:

1. **Absorption** - When large passive orders absorb aggressive flow without letting price move
2. **Momentum** - When aggressive flow moves price efficiently with no resistance
3. **Institutional Activity** - Large trades that indicate smart money participation

## Documentation Index

| File | Description |
|------|-------------|
| [metrics-guide.md](./metrics-guide.md) | Complete metric reference with formulas, interpretation, and examples |
| [pattern-detection.md](./pattern-detection.md) | The 4 core pattern detection queries with full SQL |
| [absorption-theory.md](./absorption-theory.md) | Theory behind absorption, accumulation, and distribution |
| [suggested-metrics.md](./suggested-metrics.md) | Future metrics to implement with SQL examples |

## Quick Start

```bash
# Run pattern detection for ES futures
npx tsx scripts/detect-patterns.ts ES

# For other instruments
npx tsx scripts/detect-patterns.ts NQ
npx tsx scripts/detect-patterns.ts GC
```

## The 4 Core Patterns

| # | Pattern | Signal | Key Metrics |
|---|---------|--------|-------------|
| 1 | **Bearish Absorption** | SELL (reversal) | `divergence = -1`, `vd_ratio > 0` |
| 2 | **Bullish Absorption** | BUY (reversal) | `divergence = 1`, `vd_ratio < 0` |
| 3 | **Bullish Momentum** | LONG (continuation) | `divergence = 0`, `vd_ratio > 0`, `price_pct > 0` |
| 4 | **Bearish Momentum** | SHORT (continuation) | `divergence = 0`, `vd_ratio < 0`, `price_pct < 0` |

## Key Concepts

### Aggressive vs Passive Flow

- **Aggressive (VD)** = Market orders that "lift the ask" (buy) or "hit the bid" (sell)
- **Passive (book_imbalance)** = Limit orders waiting in the book to be filled

### The Absorption Pattern

```
Normal:     Aggressive Buyers → Price Goes Up
Absorption: Aggressive Buyers + Large Passive Sellers → Price Flat/Down

Detection:  High |VD| + Low EVR + divergence ≠ 0
```

### The Momentum Pattern

```
Momentum:   Aggressive Buyers → Price Goes Up Efficiently

Detection:  VD direction = price direction + divergence = 0 + high EVR
```

### Signal Quality

Best signals have:
- `big_trades > 0` (institutional involvement)
- `book_imbalance` confirms direction
- Multiple consecutive candles with same pattern
