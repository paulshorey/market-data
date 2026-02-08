# Sliding Window Indicator Platform

Reference implementation for calculating higher-timeframe technical indicators at 1-minute resolution using sliding windows.

For the core concept of how minute_index-based indicator calculation works, see [../example/calculate-indicator-values.md](../example/calculate-indicator-values.md).

## Key Insight: One Calculator Per minute_index

RSI with Wilder's smoothing is sequential -- each value depends on the previous. But the RSI at minute_index=2 doesn't depend on minute_index=1. Each minute_index forms its own independent series:

1. minute_index=1 calculates based on previous values at 9:01, 8:01, 7:01...
2. minute_index=2 calculates based on previous values at 9:02, 8:02, 7:02...
3. minute_index=3 calculates based on previous values at 9:03, 8:03, 7:03...

So we maintain **60 independent RSI calculators** for a 60-minute timeframe. Each has its own smoothed average state.

| Timeframe | minute_index range | RSI Calculators |
|-----------|-------------------|-----------------|
| 1m | Always 1 | 1 |
| 60m | Cycles 1-60 | 60 |
| 1440m | Cycles 1-1440 | 1440 |

## RSI Calculation (Wilder's Smoothing)

```
First Average Gain = Sum of Gains over past 14 periods / 14
First Average Loss = Sum of Losses over past 14 periods / 14

Subsequent values:
Average Gain = ((Previous Avg Gain * 13) + Current Gain) / 14
Average Loss = ((Previous Avg Loss * 13) + Current Loss) / 14

RS = Average Gain / Average Loss
RSI = 100 - (100 / (1 + RS))
```

## Files

| File | Description |
|------|-------------|
| `BacktestEngine.js` | Multi-timeframe backtesting engine with chunked streaming |
| `TimeframeBuffer.js` | Memory-efficient 5,000-bar sliding window with lazy loading |
| `run.js` | Example strategies (simple RSI, multi-timeframe, divergence) |
| `index.js` | Module exports |

## Backtesting Framework

The backtesting engine runs strategies across millions of bars with constant memory usage.

### Architecture

```
┌─────────────────────────────────────────────────────┐
│                   BacktestEngine                     │
│                                                      │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐       │
│  │ Buffer 1m  │ │ Buffer 60m │ │Buffer 1440m│  ...  │
│  │ [5K window]│ │ [5K window]│ │ [5K window]│       │
│  │[50K buffer]│ │[50K buffer]│ │[50K buffer]│       │
│  └────────────┘ └────────────┘ └────────────┘       │
│                        │                             │
│                        ▼                             │
│               ┌────────────────┐                     │
│               │ User Strategy  │                     │
│               └────────────────┘                     │
└─────────────────────────────────────────────────────┘
```

### Memory

| Component | Size | Memory |
|-----------|------|--------|
| Window (5,000 bars x 10 tf) | 50K rows | ~5 MB |
| Buffer (50,000 bars x 10 tf) | 500K rows | ~50 MB |
| **Total** | | **~55 MB** |

Data is loaded in chunks as the backtest progresses. Old data is trimmed to maintain constant memory.

### Performance

Expected throughput: 50,000-200,000 bars/second depending on strategy complexity.

### Writing Strategies

```javascript
function myStrategy(ctx) {
  const tf1h = ctx.tf(60);
  const tf4h = ctx.tf(240);
  const tf1d = ctx.tf(1440);

  const current = tf1h.current();
  const prev = tf1h.get(1);
  const closes = tf1h.series('close', 20);

  if (ctx.position === 0 && current.rsi14 < 30) {
    ctx.buy(1);
  }
  if (ctx.position > 0 && current.rsi14 > 70) {
    ctx.close();
  }
}
```

### Multi-Timeframe Example

```javascript
function multiTfStrategy(ctx) {
  const rsi1h = ctx.tf(60).current().rsi14;
  const rsi4h = ctx.tf(240).current().rsi14;
  const rsi1d = ctx.tf(1440).current().rsi14;

  const allOversold = rsi1h < 30 && rsi4h < 35 && rsi1d < 40;
  const anyOverbought = rsi1h > 70 || rsi4h > 70 || rsi1d > 70;

  if (allOversold && ctx.position === 0) ctx.buy(1);
  if (anyOverbought && ctx.position > 0) ctx.close();
}
```

### Strategy API

**Context (`ctx`):**

| Property/Method | Description |
|-----------------|-------------|
| `ctx.time` | Current bar timestamp |
| `ctx.tf(minutes)` | Get timeframe accessor |
| `ctx.position` | Position size (+ long, - short, 0 flat) |
| `ctx.positionPrice` | Average entry price |
| `ctx.equity` | Capital + unrealized P&L |
| `ctx.buy(qty)` | Buy at market |
| `ctx.sell(qty)` | Sell at market |
| `ctx.close()` | Close position |

**Timeframe accessor (`ctx.tf(60)`):**

| Method | Description |
|--------|-------------|
| `.current()` | Current bar |
| `.get(n)` | Bar N periods ago |
| `.series(field, length)` | Array of field values |
| `.window()` | Full 5,000-bar window |

## Running

```bash
npm install
node run.js
```

Requires PostgreSQL connection via environment variables (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`).
