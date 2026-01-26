/**
 * Type definitions for TBBO streaming and candle aggregation
 */

/**
 * Raw TBBO (Trade with Best Bid/Offer) record from Databento
 */
export interface TbboRecord {
  /** Nanosecond epoch timestamp as string (e.g., "1768275460711927889") */
  timestamp: string;
  /** Specific contract symbol (e.g., "ESH5") */
  symbol: string;
  /** Trade price */
  price: number;
  /** Trade size/volume */
  size: number;
  /** Trade side: 'A' (ask) = aggressive buy, 'B' (bid) = aggressive sell, 'N' = unknown */
  side: string;
  /** Best bid price at time of trade */
  bidPrice: number;
  /** Best ask price at time of trade */
  askPrice: number;
  /** Best bid size */
  bidSize: number;
  /** Best ask size */
  askSize: number;
}

/**
 * Internal state for an in-progress candle being aggregated
 */
export interface CandleState {
  open: number;
  high: number;
  low: number;
  close: number;
  /** Total volume */
  volume: number;
  /** Volume from trades at ask (side='A') = aggressive buying */
  askVolume: number;
  /** Volume from trades at bid (side='B') = aggressive selling */
  bidVolume: number;
  /** Volume from trades with unknown/undetermined side */
  unknownSideVolume: number;
  /** Most recent contract symbol (for tracking active contract) */
  symbol: string;
  /** Number of trades in this candle */
  tradeCount: number;
}

/**
 * Candle data prepared for database write
 */
export interface CandleForDb {
  key: string;
  ticker: string;
  time: string;
  candle: CandleState;
}

/**
 * Aggregator statistics for monitoring
 */
export interface AggregatorStats {
  recordsProcessed: number;
  pendingCandles: number;
  candlesWritten: number;
  lateTradesRejected: number;
  unknownSideTrades: number;
  cvdByTicker: Record<string, number>;
}
