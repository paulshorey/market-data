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
  /** Volume Delta: askVolume - bidVolume */
  vd: number;
  /** VD Ratio: VD / classified volume, bounded -1 to +1 */
  vdRatio: number;
  /** Price change as percentage (basis points, 100 = 1%) */
  pricePct: number;
  /** Divergence flag: 1=bullish (accumulation), -1=bearish (distribution), 0=none */
  divergence: -1 | 0 | 1;
  /** Effort vs Result: absorption score. null = no meaningful imbalance, 0 = strong absorption */
  evr: number | null;
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
 * @param priceOpen - Opening price of the candle
 * @param priceClose - Closing price of the candle
 * @param volumeDelta - Volume delta (askVolume - bidVolume)
 * @returns 1 for bullish, -1 for bearish, 0 for no divergence
 */
export function calculateDivergence(
  priceOpen: number,
  priceClose: number,
  volumeDelta: number
): -1 | 0 | 1 {
  const priceDelta = priceClose - priceOpen;

  // Bullish divergence: bearish VD (sellers aggressive) but price went up
  // This means sellers are being absorbed - accumulation zone
  if (volumeDelta < 0 && priceDelta > 0) return 1;

  // Bearish divergence: bullish VD (buyers aggressive) but price went down
  // This means buyers are being absorbed - distribution zone
  if (volumeDelta > 0 && priceDelta < 0) return -1;

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
 * Calculate all order flow metrics from candle data
 *
 * This is the main function to compute all metrics in one call.
 * It returns a complete OrderFlowMetrics object for database storage.
 *
 * @param open - Opening price
 * @param close - Closing price
 * @param askVolume - Volume traded at ask (aggressive buys)
 * @param bidVolume - Volume traded at bid (aggressive sells)
 * @returns Complete OrderFlowMetrics object
 */
export function calculateOrderFlowMetrics(
  open: number,
  close: number,
  askVolume: number,
  bidVolume: number
): OrderFlowMetrics {
  const vd = calculateVd(askVolume, bidVolume);
  const vdRatio = calculateVdRatio(askVolume, bidVolume);
  const pricePct = calculatePricePct(open, close);
  const divergence = calculateDivergence(open, close, vd);
  const evr = calculateEvr(pricePct, vdRatio);

  return { vd, vdRatio, pricePct, divergence, evr };
}
