# Absorption Theory

Understanding how institutional players accumulate and distribute positions through absorption patterns.

## What is Absorption?

**Absorption** occurs when large passive limit orders absorb aggressive market orders without allowing price to move significantly. It reveals hidden institutional activity that isn't visible on price charts alone.

### The Mechanism

```
Normal Market Behavior:
  Aggressive Buyers → Price Goes Up
  Aggressive Sellers → Price Goes Down

Absorption (Anomaly):
  Aggressive Buyers + Large Passive Sellers → Price Flat or Down
  Aggressive Sellers + Large Passive Buyers → Price Flat or Up
```

When price doesn't move in the direction of aggressive flow, something is absorbing that flow. That "something" is typically large institutional orders.

---

## Types of Absorption

### 1. Distribution (Bearish Absorption)

**What's happening:** Institutions are selling (distributing) to retail buyers.

```
Retail → "Price is going up! I should buy!"
         → Aggressive buying (positive VD)
         
Smart Money → Large passive sell orders absorbing all the buying
           → Price doesn't go up, may even drop
           
Result → divergence = -1
      → Eventual move DOWN when selling complete
```

**Signs:**
- `vd_ratio > 0` (buyers aggressive)
- `divergence = -1` (price fell anyway)
- `book_imbalance < 0` (sellers in book)
- `big_trades > 0` (large trades involved)

### 2. Accumulation (Bullish Absorption)

**What's happening:** Institutions are buying (accumulating) from retail sellers.

```
Retail → "Price is going down! I should sell!"
         → Aggressive selling (negative VD)
         
Smart Money → Large passive buy orders absorbing all the selling
           → Price doesn't go down, may even rise
           
Result → divergence = 1
      → Eventual move UP when accumulation complete
```

**Signs:**
- `vd_ratio < 0` (sellers aggressive)
- `divergence = 1` (price rose anyway)
- `book_imbalance > 0` (buyers in book)
- `big_trades > 0` (large trades involved)

---

## Why Institutions Use Absorption

### The Problem of Size

An institution wanting to buy 10,000 contracts can't just place a market order:
- Would move price significantly against them
- Would reveal their intent to the market
- Would get poor average fill price

### The Solution: Passive Absorption

Instead, they:
1. Place large limit orders (iceberg orders that refill)
2. Let retail traders sell into them
3. Accumulate position without moving price
4. Once positioned, let the natural supply/demand imbalance move price

**Key insight:** By using limit orders, institutions become price makers, not price takers. They set the price they want and let the market come to them.

---

## Detecting Absorption

### Method 1: Divergence Flag

The simplest detection - when price moves opposite to aggressive flow:

```sql
-- Bearish absorption (distribution)
WHERE divergence = -1 AND vd_ratio > 0.15

-- Bullish absorption (accumulation)  
WHERE divergence = 1 AND vd_ratio < -0.15
```

### Method 2: EVR Analysis

**EVR (Effort vs Result)** quantifies absorption:

```
EVR = price_pct / (|vd_ratio| * 100)
```

- High EVR = Efficient (price moved as expected)
- Low EVR = Absorption (price didn't move despite effort)
- Negative EVR = Strong absorption (price moved opposite)

```sql
-- Strong absorption
WHERE ABS(vd_ratio) > 0.3 AND ABS(evr) < 0.2
```

### Method 3: Book Imbalance Confirmation

When absorption occurs, the order book often confirms:

```sql
-- Distribution: buyers aggressive but sellers waiting in book
WHERE vd_ratio > 0.15 AND book_imbalance < -0.1

-- Accumulation: sellers aggressive but buyers waiting in book
WHERE vd_ratio < -0.15 AND book_imbalance > 0.1
```

### Method 4: Big Trades Confirmation

Large trades during absorption increase signal confidence:

```sql
-- High confidence absorption signal
WHERE divergence != 0 AND big_trades > 0
```

---

## Absorption Phases

### Phase 1: Initial Absorption

- Divergence appears (price not following aggressor)
- Often subtle at first
- Low EVR values
- May not have big trades yet

### Phase 2: Heavy Absorption

- Strong and persistent divergence
- Very low or negative EVR
- Big trades present
- Book imbalance confirms
- Smart money building position

### Phase 3: Completion

- Aggressive flow starts to fade (vd_strength dropping)
- Absorption "runs out" 
- Price begins to move in absorber's direction
- Often fast move as supply/demand normalizes

---

## Trading Absorption

### Entry Timing

**Don't enter immediately on absorption signal.** Wait for:

1. Multiple consecutive candles with absorption
2. Big trades confirming institutional involvement
3. Aggressive flow starting to fade (vd_strength < 1)
4. Or: Price making new low/high that gets immediately absorbed

### Stop Placement

- For accumulation (long): Below the absorption zone lows
- For distribution (short): Above the absorption zone highs

The absorption zone represents where institutions are defending - if that level breaks, the thesis is wrong.

### Target Setting

Absorption zones often become support/resistance later:
- After accumulation: The zone becomes support
- After distribution: The zone becomes resistance

Target the next significant level in your direction, or use trailing stops once momentum develops.

---

## Real-World Examples from Data

### Example: Bullish Absorption

```
Time: 2026-01-29T15:56:00
Close: 6916.25
vd_ratio: -0.157 (sellers aggressive)
divergence: 1 (price went UP)
big_trades: 35
big_volume: 1165 contracts
price_pct: +9.77 bps

→ Heavy selling (35 big trades!) but price rose significantly
→ Massive institutional accumulation
→ Bullish reversal signal
```

### Example: Bearish Absorption

```
Time: 2026-01-29T16:04:00
Close: 6902.25
vd_ratio: 0.175 (buyers aggressive)
divergence: -1 (price went DOWN)
big_trades: 23
big_volume: 1183 contracts
price_pct: -5.43 bps

→ Heavy buying (23 big trades!) but price fell significantly
→ Massive institutional distribution
→ Bearish reversal signal
```

---

## Common Mistakes

### 1. Trading Too Early

Absorption can persist for extended periods. Institutions have large positions to build. Don't anticipate the reversal - wait for confirmation.

### 2. Ignoring Volume Context

A single candle of divergence during low volume means little. Look for absorption during active trading hours with meaningful volume.

### 3. Missing the Big Picture

Absorption at a key technical level (support/resistance, round number, previous high/low) is more significant than absorption in the middle of a range.

### 4. Fighting Strong Trends

Absorption signals during strong trends often fail. In a strong uptrend, "bearish absorption" may just be profit-taking before continuation. Consider the broader context.

---

## Combining with Other Analysis

Absorption detection is most powerful when combined with:

1. **Technical levels** - Absorption at support/resistance is more significant
2. **Time of day** - Most relevant during regular trading hours
3. **Market structure** - Consider overall trend direction
4. **Multiple timeframes** - Absorption on 1m + 5m + 15m = stronger signal
5. **Correlated markets** - Are related instruments showing similar patterns?
