# Order Flow Analysis: Research Notes

## Building a systematic order flow analysis system for CME futures

**Order flow analysis provides the most reliable confluence signals for momentum trading when implemented algorithmically using three core metrics: Order Flow Imbalance (OFI), delta divergence patterns, and volume profile structure.** Academic research demonstrates OFI explains **65-70% of contemporaneous price changes** at 10-second intervals, while practitioners report 70%+ win rates when combining footprint imbalances with technical levels. For CME equity index futures (ES, NQ, RTY) and COMEX metals (GC, SI), the optimal approach builds real-time detection systems for absorption, exhaustion, and continuation patterns from TBBO tick data—using specific thresholds like **3:1 imbalance ratios**, **800+ delta for ES** breakout confirmation, and VPIN toxicity monitoring for adverse selection risk.

---

## Academic foundations for order flow prediction

The quantitative foundation for order flow analysis rests on three decades of market microstructure research establishing that **order flow imbalance is the primary driver of short-term price movements**. The seminal Cont, Kukanov & Stoikov (2014) paper "The Price Impact of Order Book Events" demonstrates a linear relationship between OFI and price changes with R² values of 65-70% over 10-second intervals.

**Order Flow Imbalance (OFI) calculation** tracks changes at the best bid/ask:

```
OFI_k = Σ eₙ where eₙ = I{Pᵇ_n ≥ Pᵇ_{n-1}} × qᵇ_n - I{Pᵇ_n ≤ Pᵇ_{n-1}} × qᵇ_{n-1}
                    - I{Pᵃ_n ≤ Pᵃ_{n-1}} × qᵃ_n + I{Pᵃ_n ≥ Pᵃ_{n-1}} × qᵃ_{n-1}
```

The price impact relationship follows: **ΔP_k = β × OFI_k + ε_k**, where β is inversely proportional to market depth. This provides the mathematical basis for using order book dynamics to confirm breakout validity—strong OFI in the direction of price movement validates trend continuation.

**VPIN (Volume-Synchronized Probability of Informed Trading)** from Easley, López de Prado & O'Hara measures flow toxicity—the probability informed traders are adversely selecting market makers. The calculation divides trading into equal-volume buckets (typically 50), then estimates buy/sell volume using bulk classification: **V^B*τ = Σ V_i × Φ((P_i - P*{i-1}) / σ_ΔP)**. VPIN reached historical highs **2+ hours before the 2010 Flash Crash**, demonstrating predictive power for volatility events. For scalping, high VPIN (>0.5) signals elevated adverse selection risk—appropriate for reducing position size or widening stops.

**Kyle's Lambda** from the foundational Kyle (1985) model quantifies price impact per unit of order flow: **λ = σ_v / (2σ_u)**. Rising lambda indicates more informed trading activity; 1/λ represents market depth. Track rolling lambda estimates by regressing price change on signed order flow—spikes indicate potential information events requiring caution.

| Metric   | R² / Predictive Power      | Optimal Timeframe | Primary Use             |
| -------- | -------------------------- | ----------------- | ----------------------- |
| OFI      | 65-70% contemporaneous     | 10 seconds        | Breakout confirmation   |
| VPIN     | Predicts volatility events | Hours to days     | Risk management         |
| Kyle's λ | Varies by regime           | Intraday          | Informed flow detection |
| Amihud   | Illiquidity proxy          | Daily/Intraday    | Execution timing        |

---

## Absorption detection algorithms

Absorption—when large market orders are absorbed by limit orders without price movement—represents the highest-probability reversal signal in order flow analysis. The core detection algorithm implements **Effort vs. Result analysis**:

```python
def detect_absorption(volume, avg_volume, price_range, avg_range, threshold=2.0):
    effort = volume / avg_volume  # Volume spike relative to average
    result = price_range / avg_range  # Price movement relative to average
    absorption_ratio = effort / result

    if absorption_ratio > threshold:
        close_position = (close - low) / (high - low)
        if close_position > 0.5:
            return "BULLISH_ABSORPTION"  # Sellers absorbed
        else:
            return "BEARISH_ABSORPTION"  # Buyers absorbed
```

**Optimal parameters**: Volume spike multiplier of **1.618x-3.0x** the 50-period SMA combined with range contraction where current ATR is less than 1.272x the 50-period ATR. This Wyckoff-inspired approach identifies when large passive orders are defending a price level against aggressive market orders.

**Iceberg order detection** requires tracking order book dynamics. Native CME icebergs (exchange-managed) can be identified when trade volume exceeds displayed quantity at unchanged price with size refreshes. Academic research by Zotikov (2019) achieved **79% precision** using machine learning on CME data. The practical algorithm tracks: (1) reappearing liquidity at the same price after partial execution, (2) trade volume exceeding top-of-book displayed size, and (3) order ID persistence across tranche refills when MBO data is available.

**Stacked imbalances** indicate institutional participation—three or more consecutive price levels showing the same directional imbalance (≥3:1 ratio):

```python
def detect_stacked_imbalance(footprint, min_stack=3, ratio_threshold=3.0):
    consecutive_count = 0
    for price in sorted(footprint.keys()):
        ask_vol = footprint[price].ask_volume
        bid_below = footprint[price - tick_size].bid_volume

        if bid_below > 0 and ask_vol / bid_below >= ratio_threshold:
            consecutive_count += 1
            if consecutive_count >= min_stack:
                return "BULLISH_STACKED_IMBALANCE", price
        else:
            consecutive_count = 0
```

Stacked buy imbalances at range boundaries suggest accumulation before breakout; stacked sell imbalances indicate distribution. These patterns often precede **15-30 tick moves** in ES futures.

---

## Delta-based signals for momentum confirmation

Delta—the difference between volume at ask (aggressive buying) versus volume at bid (aggressive selling)—provides the most direct measure of directional conviction. **Cumulative Volume Delta (CVD)** tracks the running total from session start: CVD(t) = CVD(t-1) + (Ask_Volume - Bid_Volume).

**Delta divergence patterns** are the highest-probability reversal signals:

- **Exhaustion divergence**: Price makes new high/low, but delta does NOT confirm. Algorithm: `if price.high > price.high[lookback] AND delta.high <= delta.high[lookback]: signal = BEARISH_EXHAUSTION`

- **Absorption divergence**: Delta makes new high/low, but price does NOT confirm. This indicates aggressive orders being absorbed by passive counter-parties—strong reversal signal.

- **Single-bar divergence**: Bearish candle with positive delta indicates buying absorbed (potential bounce); bullish candle with negative delta indicates selling absorbed (potential drop). Filter for significance: require `abs(delta) > average_delta * 0.5`.

**CVD slope analysis** quantifies trend strength:

```
CVD_Slope = (CVD(t) - CVD(t-n)) / n

Rising CVD (slope > 0) = Sustained aggressive buying, trend continuation
Falling CVD (slope < 0) = Sustained aggressive selling, trend continuation
Flat CVD (slope ≈ 0) = Balanced flow, consolidation
```

For momentum confirmation, **CVD must trend with price**. When price makes new highs but CVD makes lower highs (bearish divergence), the move lacks conviction—exit longs or prepare for reversal. Professional traders use delta thresholds of **800+ contracts for ES** and **2,000-3,000+ for NQ** to confirm breakout validity.

**Delta acceleration/deceleration** measures rate of change in delta:

```python
delta_acceleration = (delta[t] - delta[t-1]) - (delta[t-1] - delta[t-2])

if delta_acceleration > 0 and price trending up:
    # Momentum building - hold/add to position
elif delta_acceleration < 0 and price trending up:
    # Momentum fading - tighten stops, prepare for exit
```

---

## Volume profile and footprint chart analysis

Volume profile construction from tick data creates a horizontal histogram showing volume distribution by price. The **Point of Control (POC)**—the price level with highest volume—acts as a magnet for price and key support/resistance.

**Value Area calculation** (typically 70% of volume) uses an expansion algorithm from POC:

```python
def calculate_value_area(profile, percentage=0.70):
    total_volume = sum(profile[p].total_volume for p in profile)
    target_volume = total_volume * percentage
    poc = max(profile.keys(), key=lambda p: profile[p].total_volume)

    current_volume = profile[poc].total_volume
    upper, lower = poc, poc

    while current_volume < target_volume:
        upper_sum = profile[upper + tick].total_volume + profile[upper + 2*tick].total_volume
        lower_sum = profile[lower - tick].total_volume + profile[lower - 2*tick].total_volume

        if upper_sum >= lower_sum:
            upper += 2 * tick
            current_volume += upper_sum
        else:
            lower -= 2 * tick
            current_volume += lower_sum

    return upper, lower, poc  # VAH, VAL, POC
```

The **80% Rule**: If price opens within the previous day's Value Area, there's an 80% probability it will traverse to the opposite side. This provides a statistical edge for intraday mean-reversion trading.

**Footprint charts** reveal bid/ask volume at each price level within a candle. The **diagonal imbalance calculation** compares ask volume at price P with bid volume at P-1 (one tick lower):

```
Buy_Imbalance = Ask[P] / Bid[P - tick_size] >= 3.0
Sell_Imbalance = Bid[P] / Ask[P + tick_size] >= 3.0
```

Standard threshold is **3:1 (300%)** for significant imbalances; 4:1 for strong signals. The diagonal comparison is crucial—horizontal comparisons miss the aggressive vs. passive dynamic.

**Finished vs. unfinished auctions** identify exhaustion:

| Pattern               | Detection                               | Interpretation                              |
| --------------------- | --------------------------------------- | ------------------------------------------- |
| Finished up auction   | Zero bids at candle high, positive asks | No buyers willing higher—reversal potential |
| Finished down auction | Zero asks at candle low, positive bids  | No sellers willing lower—bounce potential   |
| Unfinished auction    | Activity on both sides at extremes      | Price may revisit to "complete" the auction |

**High Volume Nodes (HVN)** act as support/resistance where price tends to consolidate; **Low Volume Nodes (LVN)** are breakout zones where price moves rapidly. Identify using percentile analysis: HVN = price levels above 70th percentile of volume; LVN = levels below 30th percentile.

---

## Tape reading algorithms for sweep and large trade detection

**Large trade detection** uses statistical methods to identify institutional activity:

```python
def detect_large_trade(trade_size, rolling_mean, rolling_std, k=2.5):
    z_score = (trade_size - rolling_mean) / rolling_std
    if z_score > k:  # Typically k=2.5 or use 95th percentile
        return True
    return False
```

**Trade clustering** aggregates large trades occurring at the same price level within a time window (500ms-2s). Multiple large trades clustered at a level indicate institutional accumulation/distribution—watch for price movement away from that zone.

**Sweep detection** identifies aggressive orders hitting multiple price levels rapidly:

```python
def detect_sweep(trades, time_window_ms=100, min_levels=2):
    sweeps = []
    for i, trade in enumerate(trades):
        window_trades = [t for t in trades[max(0,i-50):i+1]
                        if trade.timestamp - t.timestamp < time_window_ms
                        and t.side == trade.side]

        unique_prices = set(t.price for t in window_trades)
        if len(unique_prices) >= min_levels:
            total_volume = sum(t.size for t in window_trades)
            sweeps.append({
                'levels': len(unique_prices),
                'total_size': total_volume,
                'direction': trade.side,
                'time': trade.timestamp
            })
    return sweeps
```

Sweeps represent ~15% of large institutional trades and indicate **strong directional conviction**. Multi-sweeps (multiple sweeps in same direction within minutes) correlate with major price movements in approximately 70% of cases.

**Speed of tape analysis** measures trade frequency acceleration:

```
tape_speed = trades_per_second (5-10 second rolling average)
acceleration = (current_speed - previous_speed) / previous_speed

Speed acceleration + directional flow = momentum building
Speed deceleration + continuation = potential exhaustion
Sudden spike (>2x average) = breakout or news event
```

**VPIN implementation** for flow toxicity monitoring:

```python
def calculate_vpin(trades, bucket_size, n_buckets=50):
    buckets = divide_into_volume_buckets(trades, bucket_size)
    vpin = 0

    for bucket in buckets[-n_buckets:]:
        sigma = std_dev(price_changes)
        v_buy = sum(v * norm_cdf((p_close - p_open) / sigma) for trade in bucket)
        v_sell = bucket.total_volume - v_buy
        vpin += abs(v_buy - v_sell)

    return vpin / (n_buckets * bucket_size)
```

High VPIN (>0.5) signals elevated informed trading probability—reduce position size or widen stops during these periods.

---

## Practical implementation for CME futures scalping

**Delta thresholds by instrument** for breakout confirmation:

| Contract | Tick Size | Tick Value | Delta for Significant Level   | Delta for Strong Breakout |
| -------- | --------- | ---------- | ----------------------------- | ------------------------- |
| ES       | 0.25      | $12.50     | 800+                          | 1,600+                    |
| NQ       | 0.25      | $5.00      | 2,000+                        | 3,000+                    |
| RTY      | 0.10      | $5.00      | Lower, expect larger swings   | —                         |
| GC       | $0.10     | $10.00     | Varies by session             | —                         |
| SI       | $0.005    | $25.00     | Less liquid, wider thresholds | —                         |

**Key levels where order flow analysis provides maximum value**:

1. **Prior Day High/Low (PDH/PDL)**: Monitor for absorption or continuation delta at these liquidity clusters
2. **Session VWAP**: Institutional "fair value"—price outside 2σ with weak delta = fade back to VWAP
3. **Value Area boundaries (VAH/VAL)**: 80% rule application; watch for acceptance vs. rejection
4. **Opening Range**: Wait for price to clear with supporting delta before breakout entries
5. **Naked POCs**: Unfilled POCs from prior sessions act as magnets—track until price revisits

**Breakout confirmation checklist**:

- [ ] Strong positive delta in direction of break (800+ ES, 2,000+ NQ)
- [ ] CVD trending with price, not diverging
- [ ] Volume spike with follow-through (not isolated spike)
- [ ] Stacked imbalances across 3+ consecutive price levels
- [ ] Clean close beyond level, no immediate rejection

**False breakout indicators** (liquidity traps):

- Large resting orders that pull before getting hit (spoofing)
- Initial volume spike but no fresh orders supporting the move
- CVD divergence: price makes new high but CVD makes lower high
- Quick rejection: price hovers past breakout, then reverses sharply

**Entry timing rules**:

1. Wait for first 30-minute structure to develop (avoid false open moves)
2. Confirm breakout with delta aggression meeting instrument thresholds
3. Look for stacked imbalances and clustered block orders
4. Enter when confirmation bar closes with volume support

**Stop placement using order flow**:

- Place stops just beyond Low Volume Nodes (LVN)
- Use the extreme of the absorption bar as risk level
- For reversals, stop goes just beyond the extreme where absorption occurred
- Trail stops behind volume clusters as trade progresses

---

## Continuation versus exhaustion signal detection

**Trending move characteristics** (hold position):

| Signal              | What to Look For                                            |
| ------------------- | ----------------------------------------------------------- |
| Healthy trend       | Rising CVD with price, bullish imbalances on pullbacks      |
| Delta alignment     | Positive delta on up bars, minimal selling pressure         |
| Volume distribution | Heavy volume at pushes, light volume on pullbacks           |
| Footprint pattern   | High-volume nodes at new prices, LVN behind (single prints) |

**Exhaustion signals** (take profits/exit):

```python
def detect_exhaustion(price, delta, volume, avg_delta, avg_volume, avg_range):
    exhaustion_score = 0

    # Volume climax: spike without follow-through
    if volume > 2.5 * avg_volume:
        exhaustion_score += 0.3

    # Delta divergence: price new extreme, delta doesn't confirm
    if price_new_high and not delta_new_high:
        exhaustion_score += 0.25

    # Absorption at extremes: large delta, small price movement
    if abs(delta) > 1.5 * avg_delta and price_range < 0.5 * avg_range:
        exhaustion_score += 0.25

    # CVD divergence
    if cvd_diverging_from_price:
        exhaustion_score += 0.2

    return exhaustion_score > 0.7  # High probability reversal
```

**Holding winners using order flow**:

1. Continue holding if CVD trends in trade direction
2. Monitor for absorption at key levels that could stop the move
3. Trail stops behind volume clusters and delta zones
4. Exit if trapped trader pattern emerges against position
5. Take partial profits when imbalances weaken but CVD still supportive

**Re-entry after pullbacks**:

- Pullback to VWAP with absorption confirmation (buyers stepping in)
- Single print retest: enter on retest of high-volume node
- Delta zone retest with fresh buying/selling activity
- Gap fill to prior key level showing fresh delta in original trend direction

---

## Building your systematic order flow analysis system

**Data architecture** for real-time order flow analysis:

```python
@dataclass
class FootprintCell:
    price: float
    bid_volume: int = 0
    ask_volume: int = 0

    @property
    def delta(self) -> int:
        return self.ask_volume - self.bid_volume

    @property
    def imbalance_ratio(self, price_below_bid: int) -> float:
        if price_below_bid > 0:
            return self.ask_volume / price_below_bid
        return float('inf') if self.ask_volume > 0 else 0

class OrderFlowAnalyzer:
    def __init__(self, tick_size: float):
        self.tick_size = tick_size
        self.footprint = SortedDict()  # Price -> FootprintCell
        self.cvd = 0
        self.session_delta = 0

    def process_trade(self, price: float, volume: int, side: str):
        row = self.price_to_row(price)
        if row not in self.footprint:
            self.footprint[row] = FootprintCell(price=row)

        if side == 'buy':
            self.footprint[row].ask_volume += volume
            self.cvd += volume
        else:
            self.footprint[row].bid_volume += volume
            self.cvd -= volume

        self.session_delta = self.cvd
```

**Confluence scoring system** for trade signals:

```python
def calculate_confluence_score(signals: dict) -> float:
    weights = {
        'at_key_level': 0.20,
        'delta_confirmation': 0.25,
        'footprint_imbalance': 0.20,
        'cvd_alignment': 0.15,
        'volume_confirmation': 0.10,
        'session_timing': 0.10
    }

    score = sum(signals.get(k, 0) * w for k, w in weights.items())
    return score  # >0.7 = high probability trade
```

**Platform recommendations** for order flow scalping:

| Platform     | Strengths                                          | Monthly Cost   |
| ------------ | -------------------------------------------------- | -------------- |
| Sierra Chart | Fastest, extensive customization, lowest latency   | ~$26 + data    |
| ATAS         | Best-in-class footprint/cluster analysis           | €19.95-49.95   |
| Bookmap      | Excellent heatmap visualization, iceberg detection | ~$49           |
| NinjaTrader  | Order Flow+ suite, volumetric bars                 | Free + add-ons |

**Data requirements**: Level 2/DOM depth (minimum 10 levels), tick-by-tick time & sales with trade side classification, CME data feed (Rithmic or CQG recommended). Hardware: low-latency VPS in Chicago datacenter (<1ms to CME) for serious scalping.

**Best trading hours** for order flow reliability:

- **9:30-11:30 AM ET**: Peak liquidity, cleanest signals, highest win rates
- **8:30 AM ET**: Economic data releases (high volatility, use caution)
- **3:00-4:00 PM ET**: Power hour, increased institutional activity
- **Avoid**: Overnight session (thin liquidity, unreliable patterns)

The most effective implementation approach: start with delta divergence detection at key technical levels using the thresholds above, then layer in footprint imbalance analysis for precision entries, and finally add VPIN monitoring for risk management. Focus order flow scalping during RTH on ES initially—it offers the deepest liquidity and most reliable patterns—before expanding to NQ or metals.
