/**
 * Types for order flow metrics calculations
 */

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

  // Momentum indicators (require rolling history)
  /** VD Strength: current |VD| / recent average |VD| (>1 = above average pressure) */
  vdStrength: number;
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

  // Momentum (optional, provided by aggregator with rolling history)
  /** VD strength from rolling average (default 1 if not provided) */
  vdStrength?: number;
}

/**
 * Input for Smart Money Pressure calculation
 */
export interface SmpInput {
  vdRatio: number; // -1 to +1: aggressive order flow direction
  bookImbalance: number; // -1 to +1: passive order book imbalance
  bigVolume: number; // Volume from large trades
  volume: number; // Total volume
  evr: number | null; // Effort vs Result (absorption indicator)
  divergence: -1 | 0 | 1; // Price-delta divergence flag
  spreadBps: number; // Spread in basis points
  vdStrength?: number; // VD momentum strength (>1 = accelerating)
}
