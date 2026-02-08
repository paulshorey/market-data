# Suggested Additional Metrics

This document outlines metrics that could enhance supply/demand detection but are not yet implemented in the system.

---

## 1. Imbalance Streak

**Purpose:** Detect sustained directional pressure

**Formula:** 
```
Count of consecutive candles where VD has the same sign
Reset to 1 when VD sign changes
```

**Values:**
- 1-2 = Normal fluctuation
- 3-5 = Building pressure
- 6+ = Strong sustained pressure

**Use case:** 
- Long streaks often precede significant moves
- Streak breaking often signals reversal
- Combine with absorption: Absorption breaking a long streak = high probability reversal

**Implementation:**
```sql
-- Calculate with window function
WITH streaks AS (
  SELECT 
    time,
    vd_close,
    SIGN(vd_close) as vd_sign,
    SUM(CASE WHEN SIGN(vd_close) != LAG(SIGN(vd_close)) OVER (ORDER BY time) 
             THEN 1 ELSE 0 END) OVER (ORDER BY time) as streak_group
  FROM "candles-1m"
  WHERE ticker = 'ES'
)
SELECT time, vd_close, 
       ROW_NUMBER() OVER (PARTITION BY streak_group ORDER BY time) as streak_length
FROM streaks;
```

---

## 2. CVD Slope

**Purpose:** Measure acceleration of accumulation/distribution

**Formula:**
```
cvd_slope = (current_cvd - cvd_N_candles_ago) / N
```

Where N is typically 5 (5-minute slope).

**Values:**
- Positive slope = Accelerating buying
- Negative slope = Accelerating selling
- Slope near 0 = Balanced/consolidation
- Slope reversal = Potential direction change

**Use case:**
- Rising CVD slope + rising price = Healthy uptrend
- Rising CVD slope + flat price = Hidden accumulation (bullish)
- Falling CVD slope + rising price = Hidden distribution (bearish)
- Slope reversal often precedes price reversal

**Implementation:**
```sql
SELECT 
  time,
  cvd_close,
  (cvd_close - LAG(cvd_close, 5) OVER (ORDER BY time)) / 5.0 as cvd_slope
FROM "candles-1m"
WHERE ticker = 'ES'
ORDER BY time DESC;
```

---

## 3. Volume Spike

**Purpose:** Detect unusual activity

**Formula:**
```
volume_spike = current_volume / AVG(volume) over last 20 candles
```

**Values:**
- 0.5-1.5 = Normal volume
- 1.5-2.0 = Elevated volume
- 2.0-3.0 = High volume spike
- > 3.0 = Extreme volume (significant event)

**Use case:**
- Volume spike + divergence = Strong institutional signal
- Volume spike + momentum = Breakout confirmation
- Volume spike alone = Watch for follow-through

**Implementation:**
```sql
SELECT 
  time,
  volume,
  volume::float / AVG(volume) OVER (ORDER BY time ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) as volume_spike
FROM "candles-1m"
WHERE ticker = 'ES'
ORDER BY time DESC;
```

---

## 4. VWAP Distance

**Purpose:** Measure distance from fair value

**Formula:**
```
vwap_distance = ((close - vwap) / vwap) * 10000  -- in basis points
```

**Values:**
- > +20 bps = Extended above fair value (overbought zone)
- +5 to +20 bps = Above fair value (bullish)
- -5 to +5 bps = At fair value (neutral)
- -20 to -5 bps = Below fair value (bearish)
- < -20 bps = Extended below fair value (oversold zone)

**Use case:**
- Large positive distance + absorption = Distribution at highs
- Large negative distance + absorption = Accumulation at lows
- Mean reversion trades when extremely extended

**Implementation:**
```sql
SELECT 
  time,
  close,
  vwap_close,
  ((close - vwap_close) / vwap_close * 10000)::numeric(10,2) as vwap_distance_bps
FROM "candles-1m"
WHERE ticker = 'ES'
ORDER BY time DESC;
```

---

## 5. Absorption Intensity

**Purpose:** Single score for absorption strength

**Formula:**
```
IF divergence != 0:
  absorption_intensity = 1 / (|evr| + 0.1)
ELSE:
  absorption_intensity = 0
```

**Values:**
- 0 = No absorption (divergence = 0)
- 1-3 = Mild absorption
- 3-5 = Moderate absorption
- 5-10 = Strong absorption
- > 10 = Very strong absorption (evr near 0)

**Use case:**
- Higher values = Stronger absorption signal
- Track absorption_intensity over time to see if absorption is increasing
- Alert when absorption_intensity > 5 with big_trades > 0

**Implementation:**
```sql
SELECT 
  time,
  close,
  divergence,
  evr_close,
  CASE 
    WHEN divergence != 0 THEN 1.0 / (ABS(evr_close) + 0.1)
    ELSE 0 
  END as absorption_intensity
FROM "candles-1m"
WHERE ticker = 'ES'
ORDER BY time DESC;
```

---

## 6. Liquidity Ratio

**Purpose:** Raw bid/ask depth comparison (not normalized)

**Formula:**
```
liquidity_ratio = sum_bid_depth / sum_ask_depth
```

**Values:**
- > 2.0 = Very heavy bid support (2x more bids than asks)
- 1.5-2.0 = Strong bid support
- 0.67-1.5 = Balanced
- 0.5-0.67 = Strong ask resistance
- < 0.5 = Very heavy ask resistance

**Use case:**
- Unlike `book_imbalance` (normalized -1 to +1), this shows raw magnitude
- Ratio > 2 = Strong support, good for long entries
- Ratio < 0.5 = Strong resistance, good for short entries

**Implementation:**
```sql
SELECT 
  time,
  close,
  sum_bid_depth,
  sum_ask_depth,
  CASE WHEN sum_ask_depth > 0 
       THEN sum_bid_depth::float / sum_ask_depth 
       ELSE NULL 
  END as liquidity_ratio
FROM "candles-1m"
WHERE ticker = 'ES'
ORDER BY time DESC;
```

**Note:** Requires storing raw bid/ask depth sums, not just the normalized imbalance.

---

## 7. Delta Exhaustion

**Purpose:** Detect momentum exhaustion

**Formula:**
```
IF |vd_ratio| > 0.5 in previous candle AND |vd_ratio| < 0.15 in current candle:
  delta_exhaustion = previous vd_ratio sign (1 or -1)
ELSE:
  delta_exhaustion = 0
```

**Values:**
- +1 = Buying exhaustion (was strongly bullish, now quiet) → potential short
- -1 = Selling exhaustion (was strongly bearish, now quiet) → potential long
- 0 = No exhaustion signal

**Use case:**
- Extreme imbalance followed by quiet = Momentum spent
- Often marks short-term tops (buying exhaustion) or bottoms (selling exhaustion)
- High probability mean reversion setup

**Implementation:**
```sql
SELECT 
  time,
  close,
  vd_ratio_close,
  LAG(vd_ratio_close) OVER (ORDER BY time) as prev_vd_ratio,
  CASE 
    WHEN ABS(LAG(vd_ratio_close) OVER (ORDER BY time)) > 0.5 
         AND ABS(vd_ratio_close) < 0.15
    THEN SIGN(LAG(vd_ratio_close) OVER (ORDER BY time))
    ELSE 0 
  END as delta_exhaustion
FROM "candles-1m"
WHERE ticker = 'ES'
ORDER BY time DESC;
```

---

## 8. Momentum Score (Composite)

**Purpose:** Single score combining multiple momentum indicators

**Formula:**
```
momentum_score = 
  (vd_ratio * 40) +                    -- Direction (-40 to +40)
  (SIGN(price_pct) * |price_pct| * 2) + -- Price confirmation
  (book_imbalance * 20) +              -- Book confirmation
  (IF divergence = 0 THEN 10 ELSE -10) -- Clean vs absorbed
```

**Values:**
- +50 to +100 = Strong bullish momentum
- +20 to +50 = Moderate bullish
- -20 to +20 = Neutral/consolidation
- -50 to -20 = Moderate bearish
- -100 to -50 = Strong bearish momentum

**Use case:**
- Higher absolute value = Stronger momentum
- Compare to SMP to see if momentum aligns with institutional flow
- Momentum score >> SMP = Retail-driven move (less reliable)
- Momentum score ≈ SMP = Institutional-confirmed move (more reliable)

---

## Implementation Priority

Recommended order of implementation based on value/effort:

| Priority | Metric | Value | Effort |
|----------|--------|-------|--------|
| 1 | CVD Slope | High | Low |
| 2 | Volume Spike | High | Low |
| 3 | Absorption Intensity | High | Low |
| 4 | Delta Exhaustion | Medium | Low |
| 5 | Imbalance Streak | Medium | Medium |
| 6 | VWAP Distance | Medium | Low |
| 7 | Liquidity Ratio | Medium | Medium |
| 8 | Momentum Score | Low | Medium |

**Notes:**
- Items 1-4 can be calculated as derived columns or in queries
- Items 5-7 may require storing additional data
- Item 8 is a composite that depends on other metrics
