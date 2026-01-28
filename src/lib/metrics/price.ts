/**
 * Price Metrics: price_pct, vwap, spread_bps
 *
 * Normalized price metrics for cross-instrument comparison.
 */

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
