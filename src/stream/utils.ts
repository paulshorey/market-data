/**
 * Utility functions and constants for TBBO streaming
 *
 * This file re-exports functions from the modular library for backward compatibility.
 * New code should import directly from:
 * - ../lib/metrics/ - Order flow metric calculations
 * - ../lib/trade/ - Trade processing utilities
 */

// ============================================================================
// Re-exports from Trade Library
// ============================================================================

export {
  MAX_TRADE_AGE_MS,
  nsToMs,
  getMinuteBucket,
  toMinuteBucket,
  checkTradeAge,
} from "../lib/trade/timestamp.js";

export { extractTicker } from "../lib/trade/symbol.js";

export { inferSideFromPrice, determineTradeSide } from "../lib/trade/side-detection.js";

export { LARGE_TRADE_THRESHOLDS, getLargeTradeThreshold } from "../lib/trade/thresholds.js";

export {
  createCandleFromTrade,
  updateCandleWithTrade,
  addTradeToCandle,
} from "../lib/trade/candle-aggregation.js";

// ============================================================================
// Re-exports from Metrics Library
// ============================================================================

export type { OrderFlowMetrics, OrderFlowInput, SmpInput } from "../lib/metrics/types.js";

export { calculateVd, calculateVdRatio } from "../lib/metrics/direction.js";

export { calculateBookImbalance } from "../lib/metrics/book-imbalance.js";

export { calculatePricePct, calculateVwap, calculateSpreadBps } from "../lib/metrics/price.js";

export { calculateAvgTradeSize } from "../lib/metrics/activity.js";

export { calculateDivergence, calculateEvr } from "../lib/metrics/absorption.js";

export { MomentumTracker, MOMENTUM_WINDOW } from "../lib/metrics/momentum.js";

export { calculateSmp } from "../lib/metrics/composite.js";

export { calculateOrderFlowMetrics } from "../lib/metrics/calculate-all.js";
