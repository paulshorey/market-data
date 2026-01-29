# Market Data

## Streaming data connection

This server runs a socket connection to Databento to watch for latest futures trades TBBO data (trade by order). Each trade event includes info about its price/volume/aggressor/side. This server analyzes the data and saves multiple variants of it. This is later used for technical analysis and trading bot decisions.

## Database columns

Meta:

- time (minute candle, ISO format)
- ticker - short name (ES, GC, RTY)
- symbol - name of the contract (ESH6, GCJ6, RTYG6)

Price:

- open
- high
- low
- close
- volume

Metrics:

- vd
- cvd
- vd_ratio
- price_pct
- divergence
- evr
- book_imbalance
- vwap
- spread_bps
- trades
- avg_trade_size
- max_trade_size
- big_trades
- big_volume
- smp
- vd_strength

For each calculated metric we keep 4 OHLC variants. This allows them to be used in more types of algorithms than just the closing number. In the database, each metric is saved as 4 variants, with the suffix suffix:

- metric + `_open`
- metric + `_high`
- metric + `_low`
- metric + `_close`

---

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

---

#### `smp` - Smart Money Pressure (Composite Score)

**Formula:** Multi-factor weighted composite

```
Base = vd_ratio × 50                        // Direction (-50 to +50)
× (1 + big_volume/volume)                   // Institutional weight (1x to 2x)
± book_imbalance × 15                       // Book confluence bonus/penalty
± divergence × |vd_ratio| × 25              // Absorption adjustment
× (1 - spread_penalty)                      // Confidence factor
```

**What it measures:** A single score representing institutional-weighted directional pressure. Combines aggressive flow (VD), passive flow (book imbalance), institutional participation (big trades), absorption detection (EVR/divergence), and market confidence (spread).

**Values:** Integer from -100 to +100

| Score Range | Interpretation                                                            |
| ----------- | ------------------------------------------------------------------------- |
| +70 to +100 | **Strong institutional buying** - High probability upward continuation    |
| +40 to +70  | **Moderate bullish** - Buyers in control, watch for resistance            |
| +20 to +40  | **Mild bullish** - Slight buying bias                                     |
| -20 to +20  | **Neutral** - Consolidation or potential reversal setup                   |
| -40 to -20  | **Mild bearish** - Slight selling bias                                    |
| -70 to -40  | **Moderate bearish** - Sellers in control, watch for support              |
| -100 to -70 | **Strong institutional selling** - High probability downward continuation |

**Key features:**

1. **Institutional weighting:** Score is amplified when big trades are present (big_volume / volume ratio increases multiplier from 1x to 2x)

2. **Book confluence:** Score boosted when passive order book confirms aggressive flow direction (both bullish or both bearish). Reduced when they conflict.

3. **Absorption detection:** When divergence is detected (price moved against aggressor), score shifts toward the divergence direction, signaling potential reversal.

4. **Efficiency factor:** Low EVR (absorption) dampens the score by 30%, indicating the market is absorbing rather than trending. High EVR boosts by 20%.

5. **Confidence penalty:** Wide spread (> 5 bps) reduces score up to 30%, indicating uncertainty.

**Trading signals:**

- **Trend continuation:** High |SMP| + no divergence + narrow spread
- **Potential reversal:** Moderate |SMP| + divergence flag + high big_volume %
- **Accumulation zone:** Negative VD + positive SMP (due to divergence adjustment)
- **Distribution zone:** Positive VD + negative SMP (due to divergence adjustment)

**Example queries:**

```sql
-- Find strong institutional buying signals
SELECT * FROM "candles-1m"
WHERE ticker = 'ES' AND smp > 50
ORDER BY time DESC;

-- Find potential reversal setups (divergence with big trades)
SELECT * FROM "candles-1m"
WHERE ticker = 'ES'
  AND divergence != 0
  AND big_trades > 0
ORDER BY time DESC;

-- Calculate rolling average SMP for trend analysis
SELECT
  time,
  smp,
  AVG(smp) OVER (ORDER BY time ROWS BETWEEN 4 PRECEDING AND CURRENT ROW) AS smp_5m_avg
FROM "candles-1m"
WHERE ticker = 'ES'
ORDER BY time DESC;
```

**Implementation note:** The SMP OHLC values (smp_open, smp_high, smp_low, smp_close) are calculated without the divergence component, since divergence can only be meaningfully determined at the end of a candle when the final price change is known. The divergence metric is stored separately as a non-OHLC column. This means:

- SMP OHLC tracks the evolution of institutional-weighted pressure based on VD ratio, book imbalance, big volume, EVR, spread, and momentum
- The final `smp_close` and the standalone `divergence` column should be used together for complete analysis
- For real-time trading signals, check both `smp_close > threshold` AND `divergence != 0` conditions

---

#### `vd_strength` - Delta Momentum / Acceleration

**Formula:** `|current VD| / average(|recent VD|)` over 5-minute rolling window

**What it measures:** Whether the current aggressive pressure is accelerating or decelerating compared to recent activity. This is a momentum indicator that helps predict trend continuation vs exhaustion.

**Values:** Positive decimal (typically 0.2 to 3.0)

| Value     | Interpretation                                                    |
| --------- | ----------------------------------------------------------------- |
| > 1.5     | **Accelerating** - Current pressure is 50%+ above recent average  |
| 1.0 - 1.5 | **Steady** - Pressure is at or slightly above average             |
| 0.7 - 1.0 | **Decelerating** - Pressure is weakening                          |
| < 0.7     | **Exhaustion** - Pressure has dropped significantly below average |

**Key insight:** This metric answers: "Is the buying/selling pressure getting stronger or weaker?"

**Trading signals:**

- **Trend continuation:** `vd_strength > 1.2` + same VD direction as recent candles
- **Potential exhaustion:** `vd_strength < 0.7` + strong VD in one direction (pressure fading)
- **Breakout confirmation:** `vd_strength > 1.5` + high `big_trades` (institutions accelerating)

**Combined with SMP:**

- High SMP + high vd_strength = Strong trend, likely continuation
- High SMP + low vd_strength = Trend may be exhausting
- Low SMP + high vd_strength = Conflicting signals, watch for reversal

**Example:**

```sql
-- Find exhaustion setups (strong imbalance but fading pressure)
SELECT time, close, vd_ratio, vd_strength, smp
FROM "candles-1m"
WHERE ticker = 'ES'
  AND ABS(vd_ratio) > 0.3    -- Strong imbalance
  AND vd_strength < 0.7      -- But pressure is fading
ORDER BY time DESC;
```

## Historical data

In addition to processing streaming real-time data, this repository also contains scripts which will be called independently in the CLI, to batch process large amounts of historical data.

### TBBO (trades by order) data

scripts/historical-tbbo.ts - will process a file similar to the below example.
The real file will be very large, needs to be read in chunks!
Notice this is not a valid JSON file. It is a text list of JSON objects (JSONL format).

**Supported data formats:**

1. **Databento TBBO format** (with `levels` array):

```json
{
  "ts_recv": "2025-11-30T23:00:00.039353882Z",
  "hd": { "ts_event": "2025-11-30T23:00:00.000000000Z", "rtype": 1, "publisher_id": 1, "instrument_id": 42140878 },
  "action": "T",
  "side": "N",
  "depth": 0,
  "price": "6913.500000000",
  "size": 1,
  "flags": 0,
  "ts_in_delta": 13803,
  "sequence": 3353,
  "levels": [{ "bid_px": "6915.750000000", "ask_px": "6913.000000000", "bid_sz": 1, "ask_sz": 1, "bid_ct": 1, "ask_ct": 1 }],
  "symbol": "ESH6"
}
```

2. **Flat format** (bid/ask at top level):

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
- `side` - "A" (ask/buy), "B" (bid/sell), or "N" (neutral/unknown). When unknown, Lee-Ready algorithm infers side from price vs midpoint
- `bid_px`, `ask_px` - Best bid/ask prices (in `levels[0]` for Databento format, or at top level)
- `bid_sz`, `ask_sz` - Best bid/ask sizes for order book imbalance calculation
- Timestamps: supports ISO strings or nanosecond epochs in `hd.ts_event`, `ts_recv`, or `timestamp` fields

**Example Databento TBBO lines:**

```
{"ts_recv":"2025-11-30T23:00:00.039353882Z","hd":{"ts_event":"2025-11-30T23:00:00.000000000Z","rtype":1,"publisher_id":1,"instrument_id":42140878},"action":"T","side":"N","depth":0,"price":"6913.500000000","size":1,"flags":0,"ts_in_delta":13803,"sequence":3353,"levels":[{"bid_px":"6915.750000000","ask_px":"6913.000000000","bid_sz":1,"ask_sz":1,"bid_ct":1,"ask_ct":1}],"symbol":"ESH6"}
{"ts_recv":"2025-11-30T23:00:00.039411041Z","hd":{"ts_event":"2025-11-30T23:00:00.000000000Z","rtype":1,"publisher_id":1,"instrument_id":294973},"action":"T","side":"N","depth":0,"price":"6854.750000000","size":84,"flags":0,"ts_in_delta":14448,"sequence":3354,"levels":[{"bid_px":"6875.000000000","ask_px":"6820.000000000","bid_sz":9,"ask_sz":8,"bid_ct":1,"ask_ct":1}],"symbol":"ESZ5"}
{"ts_recv":"2025-11-30T23:00:00.041192999Z","hd":{"ts_event":"2025-11-30T23:00:00.000000000Z","rtype":1,"publisher_id":1,"instrument_id":42007065},"action":"T","side":"N","depth":0,"price":"58.750000000","size":1,"flags":0,"ts_in_delta":13932,"sequence":3355,"levels":[{"bid_px":"58.750000000","ask_px":"58.750000000","bid_sz":1,"ask_sz":1,"bid_ct":1,"ask_ct":1}],"symbol":"ESZ5-ESH6"}
```

**Note:** Spread contracts (symbols containing "-" like "ESZ5-ESH6") are automatically skipped during processing.

### Real-time streaming data

Real-time data from Databento uses fixed-point prices (strings) that must be multiplied by `1e-9`. Symbol is resolved via `instrument_id` lookup from rtype=22 mapping messages.

**Key differences from historical:**

- Prices are fixed-point integers as strings (e.g., `"7011000000000"` → `7011.0` after × 1e-9)
- Symbol NOT included - resolved from `instrument_id` via mapping
- Timestamps are nanosecond epochs as strings

**Example streaming TBBO events (from console logs):**

```
{"ts_recv":"1769642638977513181","hd":{"ts_event":"1769642638977303721","rtype":1,"publisher_id":1,"instrument_id":42140878},"action":"T","side":"B","depth":0,"price":"7011000000000","size":1,"flags":0,"ts_in_delta":13047,"sequence":29159628,"levels":[{"bid_px":"7010750000000","ask_px":"7011000000000","bid_sz":11,"ask_sz":3,"bid_ct":11,"ask_ct":2}],"ts_out":"1769642638977537040"}
{"ts_recv":"1769642639328285069","hd":{"ts_event":"1769642639328032129","rtype":1,"publisher_id":1,"instrument_id":42140878},"action":"T","side":"A","depth":0,"price":"7011000000000","size":4,"flags":0,"ts_in_delta":13478,"sequence":29159700,"levels":[{"bid_px":"7011000000000","ask_px":"7011250000000","bid_sz":4,"ask_sz":13,"bid_ct":4,"ask_ct":9}],"ts_out":"1769642639328396121"}
```

**Parsed values from first example:**

- `price`: `"7011000000000"` × 1e-9 = `7011.0`
- `bid_px`: `"7010750000000"` × 1e-9 = `7010.75`
- `ask_px`: `"7011000000000"` × 1e-9 = `7011.0`
- `side`: `"B"` (bid/sell aggressor)
- `size`: `1` contract

**To capture format:** Run streaming service and check `🔍 Raw TBBO #N:` log lines.

## TODO:

### Historical `vd_strength`

The `vd_strength` metric requires a rolling 5-minute history of VD values to calculate momentum. For real-time streaming data, this history is maintained by the aggregator. However, for historical batch processing, each candle is processed independently without maintaining rolling history, so `vd_strength` defaults to 1.0 (neutral). This means:

- For real-time data: `vd_strength` accurately reflects momentum acceleration/deceleration
- For historical data: `vd_strength` will always be 1.0 - use other metrics for momentum analysis
- If historical momentum is needed, consider post-processing queries to calculate rolling averages

**Solution:**
`scripts/historical-tbbo.ts` should remember the last 5 minutes in memory. Since the script processes a whole week or month at once, this is straightforward. There may be a 5-minute gap when processing restarts on a new file, but this is rare and acceptable.
