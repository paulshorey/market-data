# Metrics Guide

Complete reference for all order flow metrics. For quick reference, see the metrics table in `AGENTS.md`.

---

## Core Metrics

### Volume Delta (vd)

**Formula:** `askVolume - bidVolume`

**What it measures:** Net aggressive order flow within a single candle. "Aggressive" means market orders hitting resting limit orders.

| Value | Meaning |
|-------|---------|
| Positive | More buyers lifting the ask (bullish pressure) |
| Negative | More sellers hitting the bid (bearish pressure) |
| Zero | Balanced or no classified trades |

**Trading use:** Identify which side is more aggressive in a given minute. Large |VD| indicates strong directional conviction.

---

### Cumulative Volume Delta (cvd)

**Formula:** Running sum of `vd` across all candles for each ticker

**What it measures:** The cumulative aggressor imbalance over time. Unlike VD which resets each candle, CVD accumulates to show the overall trend of buyer vs seller aggression.

**Values:** Unbounded, can be any positive or negative number

**Trading use:**

| CVD Trend | Price Trend | Interpretation |
|-----------|-------------|----------------|
| Rising | Rising | Healthy uptrend (buyers in control) |
| Rising | Falling | **Bullish divergence** (accumulation) |
| Falling | Rising | **Bearish divergence** (distribution) |
| Falling | Falling | Healthy downtrend (sellers in control) |

---

### Volume Delta Ratio (vd_ratio)

**Formula:** `vd / (askVolume + bidVolume)`

**What it measures:** Normalized imbalance intensity, bounded between -1 and +1. Allows comparison across different volume levels and instruments.

| Value | Meaning |
|-------|---------|
| `+1.0` | 100% buy dominance |
| `> +0.3` | Significant buy imbalance |
| `+0.1 to +0.3` | Mild buy pressure |
| `-0.1 to +0.1` | Balanced |
| `-0.3 to -0.1` | Mild sell pressure |
| `< -0.3` | Significant sell imbalance |
| `-1.0` | 100% sell dominance |

**Trading use:** Compare imbalance intensity across instruments (ES vs CL) or across time periods with different volume levels.

**Note:** Only uses classified volume (trades where side was determined). Excludes unknown-side trades.

---

### Book Imbalance (book_imbalance)

**Formula:** `(sumBidDepth - sumAskDepth) / (sumBidDepth + sumAskDepth)`

**What it measures:** The PASSIVE order imbalance - limit orders waiting in the book at the time of each trade. Fundamentally different from VD which measures AGGRESSIVE order flow.

| Value | Meaning |
|-------|---------|
| `+1.0` | All passive depth on bid side (strong support) |
| `> 0` | More passive buyers (support below) |
| `≈ 0` | Balanced passive liquidity |
| `< 0` | More passive sellers (resistance above) |
| `-1.0` | All passive depth on ask side (strong resistance) |

**Trading use:** Predict short-term price direction based on where limit orders are waiting.

**Combined with VD for stronger signals:**

| VD | Book Imbalance | Interpretation |
|----|----------------|----------------|
| Positive | Positive | **Strong bullish** (aggressive buying into support) |
| Negative | Negative | **Strong bearish** (aggressive selling into resistance) |
| Positive | Negative | **Potential exhaustion** (buying into resistance) |
| Negative | Positive | **Potential reversal** (selling into support) |

**Key insight:** When aggressive flow (VD) conflicts with passive flow (book_imbalance), it often signals absorption and potential reversal.

---

### Divergence Flag (divergence)

**Formula:**
```
if (vd_ratio < -0.10 AND price_pct > 0.5bp) → +1 (bullish divergence)
if (vd_ratio > +0.10 AND price_pct < -0.5bp) → -1 (bearish divergence)
else → 0
```

**What it measures:** Detects when price moves AGAINST the aggressive flow direction, indicating absorption by large passive orders.

**Thresholds:**
- Requires at least 10% volume imbalance (|vd_ratio| > 0.10)
- Requires at least 0.5 basis points price move (|price_pct| > 0.5)

| Value | Meaning |
|-------|---------|
| `+1` | **Bullish divergence (Accumulation):** Sellers aggressive but price UP. Large passive buyers absorbing sell orders. |
| `-1` | **Bearish divergence (Distribution):** Buyers aggressive but price DOWN. Large passive sellers absorbing buy orders. |
| `0` | Normal behavior (price follows aggressor) or movements too small |

**Trading use:** Primary signal for detecting institutional accumulation/distribution. When divergence persists across multiple candles, it often precedes a significant move in the divergence direction.

---

### EVR - Effort vs Result (Absorption Score)

**Formula:** `price_pct / (|vd_ratio| * 100)`

**What it measures:** Price efficiency - how much price moved relative to the aggressor imbalance. When "effort" (aggressive volume) doesn't produce "result" (price movement), it indicates absorption.

| Value | Meaning |
|-------|---------|
| `NULL` | vd_ratio < 5%, no meaningful imbalance |
| `> 1.0` | Very efficient - price moved more than expected |
| `0.5 to 1.0` | Normal efficiency |
| `< 0.5` | Low efficiency - possible absorption |
| `≈ 0` | **Strong absorption** - significant imbalance but no price movement |
| `< 0` | Price moved OPPOSITE to aggressor |

**Trading use:** Quantifies absorption strength. Combine with `divergence` for full picture:

| EVR | Divergence | Interpretation |
|-----|------------|----------------|
| Low/Negative | ≠ 0 | Strong absorption signal |
| Low/Negative | = 0 | Price stalled (consolidation) |
| High | = 0 | Clean trend move |

**Example:** If vd_ratio = 0.6 (60% buy imbalance) but price_pct = 5 (0.05% move), EVR = 5 / 60 = 0.08. This very low EVR indicates strong absorption.

---

### SMP - Smart Money Pressure (Composite Score)

**Formula:**
```
Base = vd_ratio × 50                        // Direction (-50 to +50)
× (1 + big_volume/volume)                   // Institutional weight (1x to 2x)
± book_imbalance × 15                       // Book confluence bonus/penalty
± divergence × |vd_ratio| × 25              // Absorption adjustment
× (1 - spread_penalty)                      // Confidence factor
```

**What it measures:** A single score representing institutional-weighted directional pressure. Combines aggressive flow, passive flow, institutional participation, absorption detection, and market confidence.

| Range | Interpretation |
|-------|----------------|
| +70 to +100 | **Strong institutional buying** - High probability upward continuation |
| +40 to +70 | **Moderate bullish** - Buyers in control |
| +20 to +40 | **Mild bullish** - Slight buying bias |
| -20 to +20 | **Neutral** - Consolidation or potential reversal setup |
| -40 to -20 | **Mild bearish** - Slight selling bias |
| -70 to -40 | **Moderate bearish** - Sellers in control |
| -100 to -70 | **Strong institutional selling** - High probability downward continuation |

**Key features:**

1. **Institutional weighting:** Score amplified when big trades present
2. **Book confluence:** Boosted when passive book confirms aggressive flow
3. **Absorption detection:** Shifts toward divergence direction on absorption
4. **Efficiency factor:** Low EVR dampens score by 30%
5. **Confidence penalty:** Wide spread reduces score up to 30%

**Implementation note:** SMP OHLC values exclude divergence (calculated at candle close). Use `smp_close` + `divergence` together.

---

### VD Strength (vd_strength)

**Formula:** `|current VD| / average(|recent VD|)` over 5-minute rolling window

**What it measures:** Whether aggressive pressure is accelerating or decelerating compared to recent activity.

| Value | Meaning |
|-------|---------|
| > 1.5 | **Accelerating** - 50%+ above recent average |
| 1.0 - 1.5 | **Steady** - At or slightly above average |
| 0.7 - 1.0 | **Decelerating** - Pressure weakening |
| < 0.7 | **Exhaustion** - Significantly below average |

**Trading use:**

| vd_strength | SMP | Interpretation |
|-------------|-----|----------------|
| High | High | Strong trend, likely continuation |
| Low | High | Trend may be exhausting |
| High | Low | Conflicting signals, watch for reversal |

**Note:** For historical data, `vd_strength` defaults to 1.0 (no rolling history maintained in batch processing).

---

## Supporting Metrics

### Price Pct (price_pct)

**Formula:** `((close - open) / open) * 10000`

**What it measures:** Normalized price movement in basis points (1 bp = 0.01%).

| Value | Meaning |
|-------|---------|
| +100 | 1% price increase |
| +10 | 0.1% price increase |
| 0 | No change (doji candle) |
| -10 | 0.1% price decrease |

**Trading use:** Compare price movements across instruments with different price levels.

---

### Spread BPS (spread_bps)

**Formula:** `|askPrice - bidPrice| / midPrice * 10000`

**What it measures:** Market liquidity and uncertainty. Normalized to basis points.

| Value | Meaning |
|-------|---------|
| < 2 bps | High liquidity, tight market |
| 2-5 bps | Normal liquidity |
| > 5 bps | Low liquidity, uncertainty |

**Note:** Uses absolute value (bid can briefly exceed ask in fast markets). ES typical: 0.36-0.42 bps.

**Combined analysis:**

| Spread | VD | Price | Interpretation |
|--------|-----|-------|----------------|
| Wide | High | Moving | Uncertain momentum |
| Wide | High | Flat | **Absorption detected** |
| Narrow | High | Moving | **Clean trend** |
| Narrow | High | Flat | Stealth accumulation |
| Wide | Low | Any | Market uncertainty |
| Spike | Any | Any | Volatility event |

---

### VWAP (vwap)

**Formula:** `Σ(price × size) / Σ(size)` for all trades in candle

**What it measures:** Volume-weighted average price - "fair value" based on actual trading activity. Institutional execution benchmark.

| Relationship | Meaning |
|--------------|---------|
| Close > VWAP | Bullish (ended above fair value) |
| Close < VWAP | Bearish (ended below fair value) |
| Close ≈ VWAP | Neutral (accepted fair value) |

**Trading signals:**
- Large gap between close and VWAP = Strong directional conviction
- Small gap = Price oscillated around fair value
- Consistent close > VWAP = Uptrend confirmation
- Consistent close < VWAP = Downtrend confirmation

---

### Trades (trades)

**Formula:** Count of individual trades in the candle

**What it measures:** Activity level and market participation.

**Trading use:**

| Volume | Trades | Interpretation |
|--------|--------|----------------|
| High | Low | Large block trades (institutional) |
| High | High | Broad participation (retail + institutional) |
| Low | Low | Quiet market |
| Sudden spike | Any | Often precedes significant moves |

---

### Avg Trade Size (avg_trade_size)

**Formula:** `volume / trades`

**What it measures:** Typical size of orders in this candle.

**Trading use:**
- Higher than normal = Possible institutional activity
- Lower than normal = Retail activity or split orders
- Sudden increase = Often indicates institutional interest

**Note:** Trade size alone is NOT reliable for institutional vs retail. Institutions often split large orders.

---

### Max Trade Size (max_trade_size)

**Formula:** `MAX(trade.size)` for all trades in candle

**What it measures:** The largest single trade in the candle.

**Trading use:**
- Detect block trades and institutional activity
- Large max with low trade count = Single large order
- Compare to avg_trade_size to see if outlier exists

---

### Big Trades (big_trades)

**Formula:** Count of trades where `size >= threshold`

**Thresholds (CME block trade minimums):**
- ES, NQ, CL, GC: 25 contracts
- Default: 25 contracts

**Trading use:**
- `big_trades > 0` = Institutional activity likely
- High count = Multiple large participants
- Combine with `vd_ratio` to see buy/sell direction

---

### Big Volume (big_volume)

**Formula:** `SUM(trade.size)` for trades where `size >= threshold`

**What it measures:** Total volume from large trades.

**Trading use:**
- Calculate `big_volume / volume` = % institutional
- High % = Institutional dominance
- Low % = Retail-driven activity

**Combined analysis:**

| big_volume | VD | Price | Interpretation |
|------------|-----|-------|----------------|
| High | Positive | Up | Institutional buying driving price |
| High | Positive | Flat/Down | **Absorption** - institutions buying but absorbed |
| High | + divergence | Any | Strong institutional accumulation/distribution |

---

## Metric Combinations

### Absorption Detection

```
High |VD| + Low/Negative EVR + divergence != 0 = ABSORPTION

Strong signal when also:
- big_trades > 0
- book_imbalance confirms absorbing side
```

### Momentum Confirmation

```
VD and price_pct same direction + divergence = 0 + high EVR = MOMENTUM

Strong signal when also:
- vd_strength > 1.2
- book_imbalance confirms direction
- smp confirms direction
```

### Exhaustion Warning

```
High |VD| + vd_strength < 0.7 = EXHAUSTION WARNING

Watch for:
- Divergence starting to appear
- Absorption signals in opposite direction
```

---

## OHLC Variants

Each metric is stored with 4 OHLC variants:
- `metric_open` - Value at first trade of candle
- `metric_high` - Highest value during candle
- `metric_low` - Lowest value during candle
- `metric_close` - Value at last trade of candle

**Use cases:**
- `_close` - Most common, represents final state
- `_high/_low` - Range of metric during candle
- `_open vs _close` - How metric evolved (direction within candle)

---

## Example Queries

```sql
-- Absorption with institutional confirmation
SELECT time, close, vd_ratio_close, evr_close, divergence, big_trades
FROM "candles-1m"
WHERE ticker = 'ES'
  AND divergence != 0
  AND big_trades > 0
ORDER BY time DESC;

-- Strong institutional pressure
SELECT * FROM "candles-1m"
WHERE ticker = 'ES' AND ABS(smp_close) > 50
ORDER BY time DESC;

-- Exhaustion setup
SELECT time, close, vd_ratio_close, vd_strength, smp_close
FROM "candles-1m"
WHERE ticker = 'ES'
  AND ABS(vd_ratio_close) > 0.3
  AND vd_strength < 0.7
ORDER BY time DESC;

-- Clean momentum
SELECT time, close, vd_ratio_close, price_pct_close, evr_close
FROM "candles-1m"
WHERE ticker = 'ES'
  AND divergence = 0
  AND ABS(vd_ratio_close) > 0.2
  AND SIGN(vd_ratio_close) = SIGN(price_pct_close)
  AND evr_close > 0.5
ORDER BY time DESC;
```
