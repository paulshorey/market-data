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
// Momentum / Absorption Utilities
// ============================================================================

/**
 * Calculate Momentum from price change and volume delta
 *
 * Momentum = price_delta / |volume_delta|
 *
 * Measures price efficiency relative to aggressive volume activity:
 * - Positive momentum: Price moved up (bullish)
 * - Negative momentum: Price moved down (bearish)
 * - High magnitude: Efficient price movement per unit of aggressive activity
 * - Low magnitude (near zero) with high VD: Absorption - price didn't follow
 *   aggressive activity, indicating accumulation/distribution zones
 *
 * Use cases:
 * - Detect absorption: High |VD| but low |momentum| = orders being absorbed
 * - Detect divergence: Price moving opposite to VD direction
 * - Identify accumulation: Bearish VD but no price drop (sellers being absorbed)
 * - Identify distribution: Bullish VD but no price rise (buyers being absorbed)
 *
 * @param priceOpen - Opening price of the candle
 * @param priceClose - Closing price of the candle
 * @param volumeDelta - Volume delta (askVolume - bidVolume)
 * @returns Momentum value, or null if volume delta is zero (mathematically undefined)
 */
export function calculateMomentum(
  priceOpen: number,
  priceClose: number,
  volumeDelta: number
): number | null {
  // No aggressor activity = momentum is mathematically undefined
  // Return null to distinguish from "zero momentum" (price didn't move)
  if (volumeDelta === 0) {
    return null;
  }

  const priceDelta = priceClose - priceOpen;

  // Use absolute value of VD so momentum sign reflects price direction
  // This allows detecting divergence when VD and price move opposite directions
  return priceDelta / Math.abs(volumeDelta);
}
