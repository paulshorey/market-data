/**
 * Utility functions and constants for TBBO streaming
 */

// ============================================================================
// Constants
// ============================================================================

/** Maximum age (in ms) for a trade to be accepted. Trades older than this are rejected. */
export const MAX_TRADE_AGE_MS = 2 * 60 * 1000; // 2 minutes

/** Futures month codes: F(Jan), G(Feb), H(Mar), J(Apr), K(May), M(Jun), N(Jul), Q(Aug), U(Sep), V(Oct), X(Nov), Z(Dec) */
const FUTURES_MONTH_CODES = "FGHJKMNQUVXZ";

// ============================================================================
// Large Trade Detection Thresholds
// ============================================================================

/**
 * Per-instrument thresholds for "large" trade detection.
 * Trades >= this size are counted and tracked separately.
 *
 * These thresholds are based on CME block trade minimums and typical
 * institutional activity levels. Trades at or above these sizes often
 * indicate institutional positioning or algorithmic execution.
 *
 * Sources:
 * - CME Block Trade Minimum for ES: 25 contracts
 * - Typical retail: 1-10 contracts
 * - Institutional: 25-100+ contracts
 */
export const LARGE_TRADE_THRESHOLDS: Record<string, number> = {
  // E-mini S&P 500 - CME block minimum is 25
  ES: 25,
  // E-mini Nasdaq-100 - CME block minimum is 25
  NQ: 25,
  // E-mini Russell 2000 - CME block minimum is 25
  RTY: 25,
  // E-mini Dow - CME block minimum is 25
  YM: 25,
  // Crude Oil - CME block minimum is 25
  CL: 25,
  // Gold - CME block minimum is 25
  GC: 25,
  // Natural Gas - higher threshold due to different market dynamics
  NG: 50,
  // Default for unknown instruments
  DEFAULT: 25,
};

/**
 * Get the large trade threshold for a given ticker
 * @param ticker - Parent ticker (e.g., "ES", "NQ")
 * @returns Threshold in contracts
 */
export function getLargeTradeThreshold(ticker: string): number {
  return LARGE_TRADE_THRESHOLDS[ticker] ?? LARGE_TRADE_THRESHOLDS.DEFAULT;
}

/** Regex to extract ticker from futures symbol (e.g., ESH5 -> ES) */
const FUTURES_SYMBOL_REGEX = new RegExp(`^([A-Z]{1,3})[${FUTURES_MONTH_CODES}]\\d+$`);

// ============================================================================
// Timestamp Utilities
// ============================================================================

/**
 * Convert nanosecond timestamp string to milliseconds
 * @param nsTimestamp - Nanosecond epoch timestamp as string (e.g., "1768275460711927889")
 */
export function nsToMs(nsTimestamp: string): number {
  return Math.floor(parseInt(nsTimestamp, 10) / 1_000_000);
}

/**
 * Get the start of the 1-minute bucket for a nanosecond timestamp
 * @param nsTimestamp - Nanosecond epoch timestamp as string
 * @returns ISO string for the start of the minute (e.g., "2024-01-15T14:30:00.000Z")
 */
export function getMinuteBucket(nsTimestamp: string): string {
  const msTimestamp = nsToMs(nsTimestamp);
  const date = new Date(msTimestamp);
  date.setSeconds(0, 0);
  return date.toISOString();
}

// ============================================================================
// Symbol Utilities
// ============================================================================

/**
 * Extract parent ticker from contract symbol
 * 
 * Examples:
 * - ESH5 -> ES (E-mini S&P 500, March 2025)
 * - NQM5 -> NQ (E-mini Nasdaq, June 2025)
 * - CLZ4 -> CL (Crude Oil, December 2024)
 * - GCG5 -> GC (Gold, February 2025)
 * 
 * @param symbol - Contract symbol (e.g., "ESH5")
 * @returns Parent ticker (e.g., "ES") or original symbol if pattern doesn't match
 */
export function extractTicker(symbol: string | undefined): string {
  if (!symbol) {
    return "UNKNOWN";
  }
  const match = symbol.match(FUTURES_SYMBOL_REGEX);
  return match ? match[1] : symbol;
}

// ============================================================================
// Trade Side Detection (Lee-Ready Algorithm)
// ============================================================================

/**
 * Infer trade side using the Lee-Ready algorithm (1991)
 * 
 * The algorithm classifies trades based on their position relative to the bid-ask midpoint:
 * - Price > midpoint = Buyer initiated (aggressive buy at ask)
 * - Price < midpoint = Seller initiated (aggressive sell at bid)
 * - Price = midpoint = Cannot determine
 * 
 * @param price - Trade price
 * @param bidPrice - Best bid price at time of trade
 * @param askPrice - Best ask price at time of trade
 * @returns 'A' for ask (buy), 'B' for bid (sell), or null if undetermined
 */
export function inferSideFromPrice(
  price: number,
  bidPrice: number,
  askPrice: number
): "A" | "B" | null {
  // Need valid bid/ask to infer
  if (!bidPrice || !askPrice || bidPrice <= 0 || askPrice <= 0) {
    return null;
  }

  const midpoint = (bidPrice + askPrice) / 2;

  if (price > midpoint) {
    return "A"; // Trade closer to ask = aggressive buy
  } else if (price < midpoint) {
    return "B"; // Trade closer to bid = aggressive sell
  }

  // Price exactly at midpoint - cannot determine
  return null;
}

// ============================================================================
// Volume Delta Utilities
// ============================================================================

/**
 * Calculate Volume Delta from ask and bid volumes
 *
 * VD = askVolume - bidVolume
 * - Positive VD = More aggressive buying (bullish pressure)
 * - Negative VD = More aggressive selling (bearish pressure)
 *
 * @param askVolume - Total volume traded at the ask (aggressive buys)
 * @param bidVolume - Total volume traded at the bid (aggressive sells)
 */
export function calculateVd(askVolume: number, bidVolume: number): number {
  return askVolume - bidVolume;
}

// ============================================================================
// Order Flow Metrics
// ============================================================================

/**
 * Order flow metrics calculated from TBBO data
 */
export interface OrderFlowMetrics {
  // Aggressive order flow (market orders hitting limit orders)
  /** Volume Delta: askVolume - bidVolume */
  vd: number;
  /** VD Ratio: VD / classified volume, bounded -1 to +1 */
  vdRatio: number;

  // Passive order flow (limit orders waiting in book)
  /** Book Imbalance: (bidDepth - askDepth) / (bidDepth + askDepth), bounded -1 to +1 */
  bookImbalance: number;

  // Price metrics
  /** Price change as percentage (basis points, 100 = 1%) */
  pricePct: number;
  /** VWAP: Volume-weighted average price for this candle */
  vwap: number;

  // Liquidity metrics
  /** Average spread in basis points (normalized for cross-instrument comparison) */
  spreadBps: number;

  // Activity metrics
  /** Number of trades in this candle */
  trades: number;
  /** Average trade size (volume / trades) - indicates activity intensity */
  avgTradeSize: number;

  // Large trade detection
  /** Largest single trade size in this candle */
  maxTradeSize: number;
  /** Number of trades >= large trade threshold */
  bigTrades: number;
  /** Total volume from large trades */
  bigVolume: number;

  // Absorption detection
  /** Divergence flag: 1=bullish (accumulation), -1=bearish (distribution), 0=none */
  divergence: -1 | 0 | 1;
  /** Effort vs Result: absorption score. null = no meaningful imbalance, 0 = strong absorption */
  evr: number | null;

  // Composite score
  /** Smart Money Pressure: -100 to +100 institutional-weighted directional score */
  smp: number;
}

/**
 * Calculate VD Ratio (Delta Ratio)
 *
 * VD Ratio = VD / totalClassifiedVolume
 *
 * Normalized metric bounded between -1 and +1:
 * - +1 = 100% buy dominance (all volume at ask)
 * - -1 = 100% sell dominance (all volume at bid)
 * - 0 = balanced buying and selling
 *
 * This is the most important normalized metric for evaluating imbalance intensity.
 * Professional traders use this to distinguish between significant imbalances
 * (e.g., 65% delta) and noise-level readings (e.g., 8% delta).
 *
 * NOTE: Uses only classified volume (ask + bid), excluding unknown side trades.
 * This gives a more accurate picture of the known aggressor imbalance.
 * The unknownSideVolume is tracked separately in the candle but not included here.
 *
 * @param askVolume - Volume traded at the ask (aggressive buys)
 * @param bidVolume - Volume traded at the bid (aggressive sells)
 * @returns VD ratio bounded -1 to +1, or 0 if no classified volume
 */
export function calculateVdRatio(askVolume: number, bidVolume: number): number {
  const classifiedVolume = askVolume + bidVolume;
  if (classifiedVolume === 0) return 0;

  const vd = askVolume - bidVolume;
  return vd / classifiedVolume;
}

// ============================================================================
// Passive Order Flow (Book Imbalance)
// ============================================================================

/**
 * Calculate Book Imbalance (Order Book Imbalance / OBI)
 *
 * Book Imbalance = (sumBidDepth - sumAskDepth) / (sumBidDepth + sumAskDepth)
 *
 * Measures the PASSIVE order imbalance - limit orders waiting in the book.
 * This is fundamentally different from VD which measures AGGRESSIVE order flow.
 *
 * Bounded between -1 and +1:
 * - +1.0 = All passive depth is on bid side (strong support below)
 * - -1.0 = All passive depth is on ask side (strong resistance above)
 * - 0.0 = Balanced passive liquidity
 *
 * Trading signals:
 * - Positive book_imbalance = More passive buyers waiting → support
 * - Negative book_imbalance = More passive sellers waiting → resistance
 *
 * Combined with VD:
 * - VD positive + book_imbalance positive = Strong bullish (aggressive buying into support)
 * - VD negative + book_imbalance negative = Strong bearish (aggressive selling into resistance)
 * - VD positive + book_imbalance negative = Potential exhaustion (buying into resistance)
 * - VD negative + book_imbalance positive = Potential reversal (selling into support)
 *
 * @param sumBidDepth - Sum of bidSize across all trades in candle
 * @param sumAskDepth - Sum of askSize across all trades in candle
 * @returns Book imbalance bounded -1 to +1, or 0 if no depth data
 */
export function calculateBookImbalance(sumBidDepth: number, sumAskDepth: number): number {
  const totalDepth = sumBidDepth + sumAskDepth;
  if (totalDepth === 0) return 0;

  return (sumBidDepth - sumAskDepth) / totalDepth;
}

// ============================================================================
// VWAP (Volume-Weighted Average Price)
// ============================================================================

/**
 * Calculate VWAP (Volume-Weighted Average Price)
 *
 * VWAP = Σ(price × volume) / Σ(volume)
 *
 * VWAP represents the "fair value" based on actual trading activity.
 * Institutional traders use VWAP as an execution benchmark.
 *
 * Interpretation:
 * - Close > VWAP = Price ended above fair value (bullish, buyers dominated)
 * - Close < VWAP = Price ended below fair value (bearish, sellers dominated)
 * - Close ≈ VWAP = Price accepted at fair value
 *
 * The distance between close and VWAP indicates conviction:
 * - Large gap = strong directional conviction
 * - Small gap = price oscillated around fair value
 *
 * @param sumPriceVolume - Sum of (price × size) for each trade
 * @param totalVolume - Total volume
 * @returns VWAP, or 0 if no volume
 */
export function calculateVwap(sumPriceVolume: number, totalVolume: number): number {
  if (totalVolume === 0) return 0;
  return sumPriceVolume / totalVolume;
}

// ============================================================================
// Spread Analysis (Liquidity Measure)
// ============================================================================

/**
 * Calculate average spread in basis points
 *
 * Spread BPS = ((sumSpread / tradeCount) / avgMidPrice) * 10000
 *
 * Normalizes spread to basis points for cross-instrument comparison.
 * A 1-tick spread on ES (~$12.50 / ~$5000 = 2.5 bps) can be compared
 * to a 1-tick spread on CL (~$0.01 / ~$70 = 1.4 bps).
 *
 * Interpretation:
 * - Low spread (< 2 bps): High liquidity, tight market, high confidence
 * - Medium spread (2-5 bps): Normal liquidity
 * - High spread (> 5 bps): Low liquidity, uncertainty, or volatility
 *
 * Trading signals:
 * - Widening spread = Increasing uncertainty, potential volatility
 * - Narrowing spread = Increasing confidence, trend continuation likely
 * - Spike in spread = Often precedes or accompanies major moves
 *
 * @param sumSpread - Sum of (askPrice - bidPrice) across all trades
 * @param sumMidPrice - Sum of midPrice across all trades (for normalization)
 * @param tradeCount - Number of trades
 * @returns Average spread in basis points, or 0 if no trades
 */
export function calculateSpreadBps(
  sumSpread: number,
  sumMidPrice: number,
  tradeCount: number
): number {
  if (tradeCount === 0 || sumMidPrice === 0) return 0;

  const avgSpread = sumSpread / tradeCount;
  const avgMidPrice = sumMidPrice / tradeCount;

  // Convert to basis points (1 bp = 0.01%)
  return (avgSpread / avgMidPrice) * 10000;
}

// ============================================================================
// Price Metrics
// ============================================================================

/**
 * Calculate normalized price change as percentage
 *
 * Price Pct = ((close - open) / open) * 10000
 *
 * Returns price change in basis points (1 bp = 0.01%):
 * - 100 = 1% price increase
 * - -50 = 0.5% price decrease
 *
 * Using basis points provides cross-instrument comparability:
 * ES at 5000 and CL at 70 can be directly compared.
 *
 * @param priceOpen - Opening price of the candle
 * @param priceClose - Closing price of the candle
 * @returns Price change in basis points, or 0 if open is 0
 */
export function calculatePricePct(priceOpen: number, priceClose: number): number {
  if (priceOpen === 0) return 0;
  return ((priceClose - priceOpen) / priceOpen) * 10000;
}

/**
 * Minimum thresholds for meaningful divergence detection
 */
const DIVERGENCE_MIN_PRICE_PCT = 0.5; // At least 0.5 basis points price move (0.005%)
const DIVERGENCE_MIN_VD_RATIO = 0.10; // At least 10% volume imbalance

/**
 * Detect delta-price divergence (accumulation/distribution signal)
 *
 * Divergence occurs when price and volume delta move in opposite directions,
 * indicating that aggressive orders are being absorbed by passive limit orders.
 *
 * - Bullish divergence (+1): Sellers aggressive (VD < 0) but price went UP
 *   → Passive buyers absorbing sell orders (ACCUMULATION)
 *   → Large traders building long positions without pushing price down
 *
 * - Bearish divergence (-1): Buyers aggressive (VD > 0) but price went DOWN
 *   → Passive sellers absorbing buy orders (DISTRIBUTION)
 *   → Large traders distributing positions despite buying pressure
 *
 * - No divergence (0): Price followed the aggressor direction (normal behavior)
 *
 * IMPROVED: Now requires minimum thresholds to filter noise:
 * - Price must move at least 0.5 basis points (0.005%)
 * - VD ratio must be at least 10% imbalance
 *
 * @param pricePct - Normalized price change (basis points)
 * @param vdRatio - VD ratio (-1 to +1)
 * @returns 1 for bullish, -1 for bearish, 0 for no divergence
 */
export function calculateDivergence(
  pricePct: number,
  vdRatio: number
): -1 | 0 | 1 {
  // Require minimum thresholds to avoid noise
  const absPricePct = Math.abs(pricePct);
  const absVdRatio = Math.abs(vdRatio);

  // Not enough movement or imbalance to be meaningful
  if (absPricePct < DIVERGENCE_MIN_PRICE_PCT || absVdRatio < DIVERGENCE_MIN_VD_RATIO) {
    return 0;
  }

  // Bullish divergence: bearish VD (sellers aggressive) but price went up
  // This means sellers are being absorbed - accumulation zone
  if (vdRatio < 0 && pricePct > 0) return 1;

  // Bearish divergence: bullish VD (buyers aggressive) but price went down
  // This means buyers are being absorbed - distribution zone
  if (vdRatio > 0 && pricePct < 0) return -1;

  return 0;
}

/**
 * Calculate Effort vs Result (EVR) absorption score
 *
 * EVR measures the efficiency of aggressive volume in moving price.
 * When effort (aggressive volume) doesn't produce result (price movement),
 * it indicates absorption - large limit orders absorbing market orders.
 *
 * Formula: EVR = pricePct / (|vdRatio| * 100)
 *
 * Interpretation:
 * - |EVR| > 1.0: Very efficient - price moved more than expected for the imbalance
 * - |EVR| 0.5-1.0: Normal efficiency - price followed imbalance proportionally
 * - |EVR| < 0.5: Low efficiency - possible absorption
 * - |EVR| ≈ 0 with high |vdRatio|: Strong absorption signal
 * - EVR = null: No meaningful imbalance to measure (vdRatio < 5%)
 *
 * EVR sign indicates price direction (positive = up, negative = down).
 * Compare with vdRatio sign to detect divergence:
 * - Same sign: Price followed aggressor (normal)
 * - Opposite sign: Price moved against aggressor (absorption/divergence)
 *
 * Combined analysis:
 * - Low |EVR| + divergence flag: Strong absorption (accumulation/distribution)
 * - Low |EVR| + no divergence: Price stalled (consolidation, range-bound)
 * - High |EVR| + no divergence: Clean trend move
 *
 * @param pricePct - Normalized price change (basis points)
 * @param vdRatio - VD ratio (-1 to +1)
 * @returns EVR score, or null if vdRatio < 5% (no meaningful imbalance)
 */
export function calculateEvr(pricePct: number, vdRatio: number): number | null {
  // If VD ratio is very small (< 5% imbalance), EVR is not meaningful
  // Return null to distinguish from "EVR = 0" which means absorption
  const absVdRatio = Math.abs(vdRatio);
  if (absVdRatio < 0.05) return null;

  // Scale vdRatio to percentage (0-100) for more intuitive EVR values
  // A 50% VD ratio with 10bp price move = EVR of 0.2
  return pricePct / (absVdRatio * 100);
}

/**
 * Input data for order flow metric calculations
 */
export interface OrderFlowInput {
  // OHLCV
  open: number;
  close: number;
  volume: number;

  // Aggressive order flow
  askVolume: number;
  bidVolume: number;

  // Passive order flow (book depth at time of trades)
  sumBidDepth: number;
  sumAskDepth: number;

  // Spread tracking
  sumSpread: number;
  sumMidPrice: number;

  // VWAP tracking
  sumPriceVolume: number;

  // Trade count
  tradeCount: number;

  // Large trade detection
  maxTradeSize: number;
  largeTradeCount: number;
  largeTradeVolume: number;
}

/**
 * Calculate average trade size
 *
 * Average Trade Size = volume / trades
 *
 * Indicates the typical size of orders in this candle:
 * - Higher than normal = Possible institutional activity or block trades
 * - Lower than normal = Retail activity or order splitting
 * - Sudden increase = Often precedes significant moves
 *
 * Note: Trade size alone is NOT a reliable indicator of institutional
 * vs retail activity. Institutions often split large orders into
 * smaller trades to minimize market impact.
 *
 * @param volume - Total volume
 * @param tradeCount - Number of trades
 * @returns Average trade size, or 0 if no trades
 */
export function calculateAvgTradeSize(volume: number, tradeCount: number): number {
  if (tradeCount === 0) return 0;
  return volume / tradeCount;
}

// ============================================================================
// Smart Money Pressure (Composite Score)
// ============================================================================

/**
 * Input for Smart Money Pressure calculation
 */
export interface SmpInput {
  vdRatio: number;         // -1 to +1: aggressive order flow direction
  bookImbalance: number;   // -1 to +1: passive order book imbalance
  bigVolume: number;       // Volume from large trades
  volume: number;          // Total volume
  evr: number | null;      // Effort vs Result (absorption indicator)
  divergence: -1 | 0 | 1;  // Price-delta divergence flag
  spreadBps: number;       // Spread in basis points
}

/**
 * Calculate Smart Money Pressure (SMP) - Institutional-Weighted Directional Score
 *
 * SMP combines multiple order flow metrics into a single score that represents
 * the likely direction and strength of institutional activity. The score is
 * weighted more heavily when large/institutional trades are present.
 *
 * Formula components:
 * 1. Base signal = vdRatio × 50 (convert to -50 to +50 range)
 * 2. Institutional weight = 1 + (bigVolume / volume) (1x to 2x multiplier)
 * 3. Book confluence = ±15 if book_imbalance aligns with vdRatio direction
 * 4. Absorption adjustment = ±20 based on EVR and divergence
 * 5. Confidence penalty = -10% if spread > 5bps (uncertain conditions)
 *
 * Score interpretation:
 * - +50 to +100: Strong institutional buying, likely upward continuation
 * - +20 to +50: Moderate bullish pressure
 * - -20 to +20: Neutral/consolidation or reversal setup
 * - -50 to -20: Moderate bearish pressure
 * - -100 to -50: Strong institutional selling, likely downward continuation
 *
 * Special cases:
 * - Divergence present: Score moves toward divergence direction (reversal signal)
 * - Low EVR + high vdRatio: Absorption detected, score dampened
 * - High big_volume %: Score amplified (institutional conviction)
 *
 * @param input - All metrics needed for SMP calculation
 * @returns SMP score bounded -100 to +100
 */
export function calculateSmp(input: SmpInput): number {
  const { vdRatio, bookImbalance, bigVolume, volume, evr, divergence, spreadBps } = input;

  // 1. BASE SIGNAL: vdRatio scaled to -50 to +50
  // This is the primary directional component
  let score = vdRatio * 50;

  // 2. INSTITUTIONAL WEIGHT: Amplify when big trades present
  // bigVolume / volume gives 0 to 1 ratio
  // We use this to create a 1x to 2x multiplier
  const bigTradeRatio = volume > 0 ? bigVolume / volume : 0;
  const institutionalMultiplier = 1 + bigTradeRatio;
  score *= institutionalMultiplier;

  // 3. BOOK CONFLUENCE: Add ±15 if passive order book confirms direction
  // Positive book_imbalance = more bid depth (bullish support)
  // We want this to add when it aligns with vdRatio direction
  const bookAligned = (vdRatio > 0 && bookImbalance > 0) || (vdRatio < 0 && bookImbalance < 0);
  const bookConflicting = (vdRatio > 0 && bookImbalance < -0.2) || (vdRatio < 0 && bookImbalance > 0.2);

  if (bookAligned) {
    // Book confirms direction - add up to 15 based on imbalance strength
    score += Math.sign(vdRatio) * Math.abs(bookImbalance) * 15;
  } else if (bookConflicting) {
    // Book opposes direction - warning sign, reduce score
    score -= Math.sign(vdRatio) * Math.abs(bookImbalance) * 10;
  }

  // 4. ABSORPTION ADJUSTMENT: Detect hidden accumulation/distribution
  // Divergence indicates price moved against aggressor (absorption)
  if (divergence !== 0) {
    // Divergence detected - this is a potential reversal signal
    // Shift score toward the divergence direction
    // The stronger the original vdRatio, the stronger the divergence signal
    const divergenceStrength = Math.abs(vdRatio) * 25;
    score += divergence * divergenceStrength;
  }

  // EVR measures efficiency: low EVR with high vdRatio = absorption
  if (evr !== null) {
    const absEvr = Math.abs(evr);
    const absVdRatio = Math.abs(vdRatio);

    if (absEvr < 0.3 && absVdRatio > 0.3) {
      // Strong imbalance but weak price movement = absorption
      // Dampen the score (market is absorbing, not trending)
      score *= 0.7;
    } else if (absEvr > 1.5 && absVdRatio > 0.3) {
      // Price moved efficiently with the imbalance = clean trend
      // Boost the score
      score *= 1.2;
    }
  }

  // 5. CONFIDENCE PENALTY: Wide spread indicates uncertainty
  // Normal spread < 2bps, uncertain > 5bps
  if (spreadBps > 5) {
    // Reduce confidence when spread is wide
    const spreadPenalty = Math.min((spreadBps - 5) / 10, 0.3); // Max 30% penalty
    score *= (1 - spreadPenalty);
  }

  // Clamp to -100 to +100 range
  return Math.max(-100, Math.min(100, Math.round(score)));
}

/**
 * Calculate all order flow metrics from candle data
 *
 * This is the main function to compute all metrics in one call.
 * It returns a complete OrderFlowMetrics object for database storage.
 *
 * Metrics calculated:
 * - Aggressive flow: vd, vdRatio (market orders)
 * - Passive flow: bookImbalance (limit orders waiting)
 * - Price: pricePct, vwap
 * - Liquidity: spreadBps
 * - Activity: trades, avgTradeSize
 * - Large trades: maxTradeSize, bigTrades, bigVolume
 * - Absorption: divergence, evr
 *
 * @param input - All candle data needed for metric calculation
 * @returns Complete OrderFlowMetrics object
 */
export function calculateOrderFlowMetrics(input: OrderFlowInput): OrderFlowMetrics {
  const {
    open,
    close,
    volume,
    askVolume,
    bidVolume,
    sumBidDepth,
    sumAskDepth,
    sumSpread,
    sumMidPrice,
    sumPriceVolume,
    tradeCount,
    maxTradeSize,
    largeTradeCount,
    largeTradeVolume,
  } = input;

  // Aggressive order flow
  const vd = calculateVd(askVolume, bidVolume);
  const vdRatio = calculateVdRatio(askVolume, bidVolume);

  // Passive order flow
  const bookImbalance = calculateBookImbalance(sumBidDepth, sumAskDepth);

  // Price metrics
  const pricePct = calculatePricePct(open, close);
  const vwap = calculateVwap(sumPriceVolume, volume);

  // Liquidity
  const spreadBps = calculateSpreadBps(sumSpread, sumMidPrice, tradeCount);

  // Activity metrics
  const trades = tradeCount;
  const avgTradeSize = calculateAvgTradeSize(volume, tradeCount);

  // Large trade metrics (passed through from aggregation)
  const bigTrades = largeTradeCount;
  const bigVolume = largeTradeVolume;

  // Absorption detection (using normalized values for better thresholding)
  const divergence = calculateDivergence(pricePct, vdRatio);
  const evr = calculateEvr(pricePct, vdRatio);

  // Smart Money Pressure: Composite institutional-weighted score
  const smp = calculateSmp({
    vdRatio,
    bookImbalance,
    bigVolume,
    volume,
    evr,
    divergence,
    spreadBps,
  });

  return {
    vd,
    vdRatio,
    bookImbalance,
    pricePct,
    vwap,
    spreadBps,
    trades,
    avgTradeSize,
    maxTradeSize,
    bigTrades,
    bigVolume,
    divergence,
    evr,
    smp,
  };
}
