# Market Data back-end

This NodeJS app will run continuously, polling APIs every 10 seconds for new futures and crypto prices and statistics. It will filter, aggregate and format the data, and save the analysis to our own database.

It will also serve the aggregated formatted data via APIs for use by web apps and bots.

## Hosting Platform

[Railway](https://railway.com)

Documentation about Railway is available locally in this codebase, inside the "docs" folder. When you need to know how to configure or deploy something, read the many .md files inside ./docs folder.

## Code Structure

TypeScript with ES Modules. Uses `tsx` to run directly without build step.

- `src/index.ts` - Express server and route handlers
- `src/lib` - Library functions to help with APIs and algorithms
- `src/stream` -

### Column Reference

#### `vd` - Volume Delta

**Formula:** `askVolume - bidVolume`

**What it measures:** The net difference between aggressive buying and aggressive selling within a single candle. "Aggressive" means market orders hitting resting limit orders.

**Values:**

- Positive = More buyers lifting the ask (bullish pressure)
- Negative = More sellers hitting the bid (bearish pressure)
- Zero = Balanced or no classified trades

**Use case:** Identify which side is more aggressive in a given minute. Large |VD| indicates strong directional conviction.

---

#### `cvd` - Cumulative Volume Delta

**Formula:** Running sum of `vd` across all candles for each ticker

**What it measures:** The cumulative aggressor imbalance over time. Unlike VD which resets each candle, CVD accumulates to show the overall trend of buyer vs seller aggression.

**Values:** Unbounded, can be any positive or negative number

**Use case:**

- Rising CVD + rising price = healthy uptrend (buyers in control)
- Rising CVD + falling price = **bearish divergence** (distribution)
- Falling CVD + rising price = **bullish divergence** (accumulation)
- Falling CVD + falling price = healthy downtrend (sellers in control)

---

#### `vd_ratio` - Volume Delta Ratio

**Formula:** `vd / (askVolume + bidVolume)`

**What it measures:** Normalized imbalance intensity, bounded between -1 and +1. This allows comparison across different volume levels and instruments.

**Values:**

- `+1.0` = 100% buy dominance (all classified volume was aggressive buying)
- `-1.0` = 100% sell dominance (all classified volume was aggressive selling)
- `0.0` = Perfectly balanced or no classified volume
- Typical significant imbalance: |vd_ratio| > 0.3

**Use case:** Compare imbalance intensity across instruments (ES vs CL) or across time periods with different volume levels. A vd_ratio of 0.5 means the same thing whether total volume was 100 or 10,000 contracts.

**Note:** Only uses classified volume (trades where side was determined). Excludes unknown-side trades.

---

#### `book_imbalance` - Order Book Imbalance

**Formula:** `(sumBidDepth - sumAskDepth) / (sumBidDepth + sumAskDepth)`

**What it measures:** The PASSIVE order imbalance - limit orders waiting in the book at the time of each trade. This is fundamentally different from VD which measures AGGRESSIVE order flow.

**Values:**

- `+1.0` = All passive depth is on bid side (strong support below)
- `-1.0` = All passive depth is on ask side (strong resistance above)
- `0.0` = Balanced passive liquidity

**Use case:** Predict short-term price direction based on where limit orders are waiting:

- Positive book_imbalance = More passive buyers waiting → potential support
- Negative book_imbalance = More passive sellers waiting → potential resistance

**Combined with VD for stronger signals:**

- VD positive + book_imbalance positive = **Strong bullish** (aggressive buying into support)
- VD negative + book_imbalance negative = **Strong bearish** (aggressive selling into resistance)
- VD positive + book_imbalance negative = **Potential exhaustion** (buying into resistance)
- VD negative + book_imbalance positive = **Potential reversal** (selling into support)

---

#### `price_pct` - Price Percentage Change

**Formula:** `((close - open) / open) * 10000`

**What it measures:** Normalized price movement in basis points (1 bp = 0.01%).

**Values:**

- `100` = 1% price increase
- `-50` = 0.5% price decrease
- `0` = No price change (doji candle)

**Use case:** Compare price movements across instruments with vastly different price levels. A 5-point move on ES (~5000) and a $0.35 move on CL (~70) can be directly compared when expressed in basis points.

---

#### `vwap` - Volume-Weighted Average Price

**Formula:** `Σ(price × size) / Σ(size)` for all trades in the candle

**What it measures:** The "fair value" price based on actual trading activity, weighted by volume. Institutional traders use VWAP as an execution benchmark.

**Values:** A price value (same units as open/high/low/close)

**Use case:** Compare close to VWAP to assess price acceptance:

- Close > VWAP = Price ended above fair value (bullish, buyers dominated)
- Close < VWAP = Price ended below fair value (bearish, sellers dominated)
- Close ≈ VWAP = Price accepted at fair value (consolidation)

**Trading signals:**

- Large gap between close and VWAP = Strong directional conviction
- Small gap = Price oscillated around fair value (range-bound)
- Price consistently above VWAP = Uptrend confirmation
- Price consistently below VWAP = Downtrend confirmation

---

#### `spread_bps` - Average Spread in Basis Points

**Formula:** `((avgSpread / avgMidPrice) * 10000)` where avgSpread = average of (askPrice - bidPrice) across all trades

**What it measures:** Market liquidity and uncertainty. Normalized to basis points for cross-instrument comparison.

**Values:**

- `< 2 bps` = High liquidity, tight market, high confidence
- `2-5 bps` = Normal liquidity
- `> 5 bps` = Low liquidity, uncertainty, or volatility

**Use case:** Assess market conditions and confidence:

- Widening spread = Increasing uncertainty, potential volatility ahead
- Narrowing spread = Increasing confidence, trend continuation likely
- Spike in spread = Often precedes or accompanies major moves

**Combined analysis:**

- Wide spread + high VD = Low confidence aggressive move (potential reversal)
- Narrow spread + high VD = High confidence aggressive move (trend continuation)
- Wide spread + low VD = Market uncertainty, waiting for catalyst

---

#### `trades` - Trade Count

**Formula:** Count of individual trades in the candle

**What it measures:** Activity level and market participation during the candle.

**Values:** Integer, typically 1 to thousands depending on instrument and time of day

**Use case:**

- High trade count = Active market, high participation
- Low trade count = Quiet market, low participation
- Sudden spike in trades = Often precedes or accompanies significant moves
- Combined with volume: High volume + low trades = Large block trades (institutional)
- Combined with volume: High volume + high trades = Broad participation (retail + institutional)

---

#### `avg_trade_size` - Average Trade Size

**Formula:** `volume / trades`

**What it measures:** The typical size of orders in this candle.

**Values:** Decimal number (contracts per trade)

**Use case:**

- Higher than normal = Possible institutional activity or block trades
- Lower than normal = Retail activity or institutions splitting large orders
- Sudden increase = Often indicates institutional interest
- Consistent with historical average = Normal market activity

**Important note:** Trade size alone is NOT a reliable indicator of institutional vs retail. Institutions often split large orders into smaller trades to minimize market impact. Use in combination with other metrics.

---

#### `max_trade_size` - Maximum Trade Size

**Formula:** `MAX(trade.size)` for all trades in candle

**What it measures:** The largest single trade that occurred during this candle.

**Values:** Integer (contracts)

**Use case:**
- Detect block trades and institutional activity
- Unusually large max_trade_size with low trade count = Single large order
- Compare to avg_trade_size to see if there was an outlier

---

#### `big_trades` - Large Trade Count

**Formula:** Count of trades where `size >= threshold`

**What it measures:** Number of trades that exceeded the "large trade" threshold for this instrument.

**Thresholds (based on CME block trade minimums):**
- ES (E-mini S&P 500): 25 contracts
- NQ (E-mini Nasdaq): 25 contracts
- CL (Crude Oil): 25 contracts
- GC (Gold): 25 contracts
- Default: 25 contracts

**Values:** Integer (count of large trades)

**Use case:**
- `big_trades > 0` = Institutional activity likely present
- High big_trades = Multiple large participants active
- Combine with `vd_ratio` to see if large trades were buying or selling

---

#### `big_volume` - Large Trade Volume

**Formula:** `SUM(trade.size)` for trades where `size >= threshold`

**What it measures:** Total volume from trades that exceeded the large trade threshold.

**Values:** Integer (contracts)

**Use case:**
- Calculate `big_volume / volume` = % of volume from large trades
- High percentage = Institutional dominance
- Low percentage = Retail-driven activity
- Compare big_volume side (using VD) to price direction for absorption signals

**Combined analysis:**
- High big_volume + VD positive + price up = Institutional buying driving price
- High big_volume + VD positive + price flat/down = **Absorption** - institutions buying but price not moving
- High big_volume + divergence flag = Strong institutional accumulation/distribution signal

---

#### `divergence` - Price-Delta Divergence Flag

**Formula:**

```
if (vd_ratio < -0.10 AND price_pct > 0.5bp) → +1 (bullish)
if (vd_ratio > +0.10 AND price_pct < -0.5bp) → -1 (bearish)
else → 0
```

**What it measures:** Detects when price moves against the aggressor direction, indicating absorption by large passive orders.

**Improved thresholds (to reduce noise):**

- Requires at least 10% volume imbalance (|vd_ratio| > 0.10)
- Requires at least 0.5 basis points price move (|price_pct| > 0.5)

**Values:**

- `+1` = **Bullish divergence (Accumulation):** Sellers were aggressive (VD < 0) but price still went UP. Large passive buyers are absorbing sell orders without letting price drop. Smart money building longs.
- `-1` = **Bearish divergence (Distribution):** Buyers were aggressive (VD > 0) but price still went DOWN. Large passive sellers are absorbing buy orders without letting price rise. Smart money exiting longs.
- `0` = No divergence. Either price followed the aggressor direction (normal behavior), or the movements were too small to be meaningful.

**Use case:** Primary signal for detecting institutional accumulation/distribution. When divergence persists across multiple candles, it often precedes a significant move in the divergence direction.

---

#### `evr` - Effort vs Result (Absorption Score)

**Formula:** `price_pct / (|vd_ratio| * 100)`

**What it measures:** Price efficiency - how much price moved relative to the aggressor imbalance. When "effort" (aggressive volume) doesn't produce "result" (price movement), it indicates absorption.

**Values:**

- `NULL` = vd_ratio < 5%, no meaningful imbalance to measure
- `> 1.0` = Very efficient - price moved more than expected
- `0.5 to 1.0` = Normal efficiency
- `< 0.5` = Low efficiency - possible absorption
- `≈ 0` = **Strong absorption** - significant imbalance but no price movement

**Use case:** Quantifies absorption strength. Combine with `divergence` for full picture:

- Low |EVR| + divergence ≠ 0 → Strong absorption signal (accumulation/distribution)
- Low |EVR| + divergence = 0 → Price stalled (consolidation, range-bound)
- High |EVR| + divergence = 0 → Clean trend move, price following aggressor

**Example:** If vd_ratio = 0.6 (60% buy imbalance) but price_pct = 5 (0.05% move), EVR = 5 / 60 = 0.08. This very low EVR indicates strong absorption - aggressive buyers are being absorbed by passive sellers.
