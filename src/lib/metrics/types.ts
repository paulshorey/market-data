/**
 * Types for order flow metrics calculations
 */

/**
 * Order flow metrics calculated from TBBO data
 *
 * Simplified schema: only CVD retains OHLC tracking.
 * All other metrics are single (close) values.
 * Removed: vwap (per-candle not useful), spreadBps, avgTradeSize,
 *          evr, smp, vdStrength (all derivable at query time or not useful).
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

  // Activity metrics
  /** Number of trades in this candle */
  trades: number;

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

  // Trade count
  tradeCount: number;

  // Large trade detection
  maxTradeSize: number;
  largeTradeCount: number;
  largeTradeVolume: number;
}
