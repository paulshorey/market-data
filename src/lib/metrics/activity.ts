/**
 * Activity Metrics: trades, avg_trade_size
 *
 * Measures trading activity intensity and patterns.
 */

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
