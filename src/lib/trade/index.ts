/**
 * Trade Processing Library
 *
 * Shared utilities for processing TBBO trade data into candles with order flow metrics.
 * Used by both streaming (tbbo-aggregator) and historical (historical-tbbo) processors.
 */

// Types
export type {
  TbboRecord,
  CandleState,
  CandleForDb,
  AggregatorStats,
  NormalizedTrade,
  MetricCalculationContext,
} from "./types.js";

// Side detection (Lee-Ready algorithm)
export { inferSideFromPrice, determineTradeSide } from "./side-detection.js";

// Large trade thresholds
export { LARGE_TRADE_THRESHOLDS, getLargeTradeThreshold } from "./thresholds.js";

// Timestamp utilities
export {
  MAX_TRADE_AGE_MS,
  nsToMs,
  getMinuteBucket,
  toMinuteBucket,
  checkTradeAge,
} from "./timestamp.js";

// Symbol utilities
export { extractTicker } from "./symbol.js";

// Candle aggregation
export {
  createCandleFromTrade,
  updateCandleWithTrade,
  addTradeToCandle,
  updateCandleCvdOHLC,
  addTradeAndUpdateMetrics,
} from "./candle-aggregation.js";

// Database writer utilities
export type { CvdContext } from "./db-writer.js";
export {
  COLUMNS_PER_ROW,
  buildPlaceholder,
  buildCandleInsertQuery,
  buildCandleInsertParams,
  buildFallbackRowValues,
  buildOhlcRowValues,
} from "./db-writer.js";
