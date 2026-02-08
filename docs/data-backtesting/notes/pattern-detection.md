# Pattern Detection Queries

This document details the 4 core pattern detection queries for identifying trading opportunities.

## Pattern Summary

| # | Pattern | Signal | When to Trade |
|---|---------|--------|---------------|
| 1 | Bearish Absorption | SELL | Reversal from uptrend |
| 2 | Bullish Absorption | BUY | Reversal from downtrend |
| 3 | Bullish Momentum | LONG | Trend continuation up |
| 4 | Bearish Momentum | SHORT | Trend continuation down |

---

## 1. Bearish Absorption (Distribution)

**Signal Type:** SELL / Bearish Reversal

**What it detects:** Aggressive buyers hitting large passive sell orders. The buying pressure is being absorbed without moving price up - often precedes a move DOWN.

### The Pattern

```
Buyers aggressive (vd_ratio > 0)  +  Price goes DOWN (divergence = -1)
                    ↓
    Large passive sellers absorbing the buying
                    ↓
           Distribution = BEARISH
```

### Query

```sql
SELECT 
  time,
  close,
  ROUND(vd_ratio_close::numeric, 3) as vd_ratio,
  ROUND(book_imbalance_close::numeric, 3) as book_imb,
  ROUND(evr_close::numeric, 2) as evr,
  ROUND(price_pct_close::numeric, 2) as price_pct,
  big_trades,
  big_volume,
  ROUND(smp_close::numeric, 0) as smp
FROM "candles-1m"
WHERE ticker = 'ES'
  AND divergence = -1                      -- Price DOWN despite buying
  AND vd_ratio_close > 0.15                -- Meaningful buy pressure
  AND book_imbalance_close IS NOT NULL     -- Has book data
ORDER BY 
  big_trades DESC,                         -- Prioritize institutional signals
  ABS(vd_ratio_close) DESC                 -- Then by imbalance strength
LIMIT 15;
```

### Interpreting Results

| Column | Good Signal | Meaning |
|--------|-------------|---------|
| `vd_ratio` | > 0.2 | Strong buying pressure |
| `book_imb` | < 0 | Sellers in book (resistance above) |
| `evr` | < 0 or small | High effort, low result |
| `big_trades` | > 0 | Institutional involvement |
| `smp` | Positive but small | Buying pressure not translating |

### Trading Application

- **Entry:** Short when bearish absorption detected, especially with `big_trades > 0`
- **Confirmation:** Look for `book_imbalance < 0` (passive sellers waiting)
- **Stop:** Above recent high
- **Target:** Next support level or when bullish absorption appears

---

## 2. Bullish Absorption (Accumulation)

**Signal Type:** BUY / Bullish Reversal

**What it detects:** Aggressive sellers hitting large passive buy orders. The selling pressure is being absorbed without moving price down - often precedes a move UP.

### The Pattern

```
Sellers aggressive (vd_ratio < 0)  +  Price goes UP (divergence = 1)
                    ↓
    Large passive buyers absorbing the selling
                    ↓
          Accumulation = BULLISH
```

### Query

```sql
SELECT 
  time,
  close,
  ROUND(vd_ratio_close::numeric, 3) as vd_ratio,
  ROUND(book_imbalance_close::numeric, 3) as book_imb,
  ROUND(evr_close::numeric, 2) as evr,
  ROUND(price_pct_close::numeric, 2) as price_pct,
  big_trades,
  big_volume,
  ROUND(smp_close::numeric, 0) as smp
FROM "candles-1m"
WHERE ticker = 'ES'
  AND divergence = 1                       -- Price UP despite selling
  AND vd_ratio_close < -0.15               -- Meaningful sell pressure
  AND book_imbalance_close IS NOT NULL     -- Has book data
ORDER BY 
  big_trades DESC,                         -- Prioritize institutional signals
  ABS(vd_ratio_close) DESC                 -- Then by imbalance strength
LIMIT 15;
```

### Interpreting Results

| Column | Good Signal | Meaning |
|--------|-------------|---------|
| `vd_ratio` | < -0.2 | Strong selling pressure |
| `book_imb` | > 0 | Buyers in book (support below) |
| `evr` | Small positive | High effort, low result |
| `big_trades` | > 0 | Institutional involvement |
| `smp` | Negative but small | Selling pressure not translating |

### Trading Application

- **Entry:** Long when bullish absorption detected, especially with `big_trades > 0`
- **Confirmation:** Look for `book_imbalance > 0` (passive buyers waiting)
- **Stop:** Below recent low
- **Target:** Next resistance level or when bearish absorption appears

---

## 3. Bullish Momentum (Clean Uptrend)

**Signal Type:** LONG / Trend Continuation

**What it detects:** Buyers aggressively pushing price higher with no absorption. Price is moving efficiently in the direction of the aggressive flow.

### The Pattern

```
Buyers aggressive (vd_ratio > 0)  +  Price goes UP (price_pct > 0)  +  No divergence
                    ↓
         No resistance, clean trend
                    ↓
       Momentum likely to CONTINUE UP
```

### Query

```sql
SELECT 
  time,
  close,
  ROUND(vd_ratio_close::numeric, 3) as vd_ratio,
  ROUND(book_imbalance_close::numeric, 3) as book_imb,
  ROUND(evr_close::numeric, 2) as evr,
  ROUND(price_pct_close::numeric, 2) as price_pct,
  big_trades,
  ROUND(smp_close::numeric, 0) as smp,
  ROUND(vd_strength::numeric, 2) as vd_str
FROM "candles-1m"
WHERE ticker = 'ES'
  AND divergence = 0                       -- Price following aggressor (clean move)
  AND vd_ratio_close > 0.15                -- Buy pressure
  AND price_pct_close > 0.5                -- Price moving up
  AND evr_close > 0                        -- Positive efficiency
  AND smp_close > 0                        -- Positive institutional pressure
  AND book_imbalance_close IS NOT NULL
ORDER BY 
  (vd_ratio_close * price_pct_close) DESC  -- Combined momentum score
LIMIT 15;
```

### Interpreting Results

| Column | Good Signal | Meaning |
|--------|-------------|---------|
| `vd_ratio` | > 0.2 | Strong buying pressure |
| `price_pct` | > 1 | Significant price increase |
| `evr` | > 0.1 | Efficient price movement |
| `book_imb` | > 0 | Support below (buyers in book) |
| `vd_str` | > 1.2 | Accelerating momentum |
| `smp` | > 20 | Strong bullish pressure |

### Trading Application

- **Entry:** Long on pullbacks during bullish momentum
- **Confirmation:** `vd_strength > 1` (accelerating), `book_imbalance > 0` (support)
- **Avoid:** When `divergence != 0` appears (absorption starting)
- **Exit:** When momentum fades (`vd_strength < 0.7`) or absorption detected

---

## 4. Bearish Momentum (Clean Downtrend)

**Signal Type:** SHORT / Trend Continuation

**What it detects:** Sellers aggressively pushing price lower with no absorption. Price is moving efficiently in the direction of the aggressive flow.

### The Pattern

```
Sellers aggressive (vd_ratio < 0)  +  Price goes DOWN (price_pct < 0)  +  No divergence
                    ↓
         No support, clean trend
                    ↓
      Momentum likely to CONTINUE DOWN
```

### Query

```sql
SELECT 
  time,
  close,
  ROUND(vd_ratio_close::numeric, 3) as vd_ratio,
  ROUND(book_imbalance_close::numeric, 3) as book_imb,
  ROUND(evr_close::numeric, 2) as evr,
  ROUND(price_pct_close::numeric, 2) as price_pct,
  big_trades,
  ROUND(smp_close::numeric, 0) as smp,
  ROUND(vd_strength::numeric, 2) as vd_str
FROM "candles-1m"
WHERE ticker = 'ES'
  AND divergence = 0                       -- Price following aggressor (clean move)
  AND vd_ratio_close < -0.15               -- Sell pressure
  AND price_pct_close < -0.5               -- Price moving down
  AND evr_close > 0                        -- Positive efficiency
  AND smp_close < 0                        -- Negative institutional pressure
  AND book_imbalance_close IS NOT NULL
ORDER BY 
  (ABS(vd_ratio_close) * ABS(price_pct_close)) DESC
LIMIT 15;
```

### Interpreting Results

| Column | Good Signal | Meaning |
|--------|-------------|---------|
| `vd_ratio` | < -0.2 | Strong selling pressure |
| `price_pct` | < -1 | Significant price decrease |
| `evr` | > 0.1 | Efficient price movement |
| `book_imb` | < 0 | Resistance above (sellers in book) |
| `vd_str` | > 1.2 | Accelerating momentum |
| `smp` | < -20 | Strong bearish pressure |

### Trading Application

- **Entry:** Short on bounces during bearish momentum
- **Confirmation:** `vd_strength > 1` (accelerating), `book_imbalance < 0` (resistance)
- **Avoid:** When `divergence != 0` appears (absorption starting)
- **Exit:** When momentum fades (`vd_strength < 0.7`) or absorption detected

---

## Combined Strategy

### Ideal Trade Setups

**Best Reversal Setup:**
1. Strong momentum in one direction (pattern 3 or 4)
2. Followed by absorption signal (pattern 1 or 2)
3. With `big_trades > 0` (institutional confirmation)

**Best Continuation Setup:**
1. Absorption signal (reversal detected)
2. Followed by clean momentum in new direction
3. With `book_imbalance` confirming direction

### Signal Quality Scoring

Score each signal 1-5 based on:

| Factor | Points |
|--------|--------|
| `big_trades > 0` | +2 |
| `book_imbalance` confirms direction | +1 |
| `vd_ratio` > 0.3 (or < -0.3) | +1 |
| `spread_bps` normal (< 0.5 for ES) | +1 |

**4-5 points = High quality signal**
**2-3 points = Moderate signal, wait for confirmation**
**0-1 points = Weak signal, avoid**
