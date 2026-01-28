/**
 * Order Flow Metrics Library
 *
 * This library provides functions to calculate various order flow metrics
 * from TBBO (Trade with Best Bid/Offer) data.
 *
 * Metrics Categories:
 * 1. Direction: vd_ratio, cvd - WHO is aggressive
 * 2. Confirmation: book_imbalance - passive support/resistance
 * 3. Institutional: big_trades, big_volume - weight the signal
 * 4. Efficiency: evr - if price is responding to pressure
 * 5. Absorption: divergence - hidden accumulation/distribution
 * 6. Momentum: vd_strength - if pressure is accelerating or exhausting
 * 7. Composite: smp - combines everything into one actionable score
 */

// Types
export type { OrderFlowMetrics, OrderFlowInput, SmpInput } from "./types.js";

// Direction metrics (vd, vd_ratio)
export { calculateVd, calculateVdRatio } from "./direction.js";

// Confirmation (book_imbalance)
export { calculateBookImbalance } from "./book-imbalance.js";

// Price metrics (price_pct, vwap, spread_bps)
export { calculatePricePct, calculateVwap, calculateSpreadBps } from "./price.js";

// Activity metrics (avg_trade_size)
export { calculateAvgTradeSize } from "./activity.js";

// Absorption metrics (divergence, evr)
export { calculateDivergence, calculateEvr } from "./absorption.js";

// Momentum metrics (vd_strength)
export { MomentumTracker, MOMENTUM_WINDOW } from "./momentum.js";

// Composite metrics (smp)
export { calculateSmp } from "./composite.js";

// Main calculation function
export { calculateOrderFlowMetrics } from "./calculate-all.js";

// OHLC tracking for metrics
export type { MetricOHLC, MetricsOHLC } from "./ohlc.js";
export {
  initMetricOHLC,
  updateMetricOHLC,
  initAllMetricsOHLC,
  updateAllMetricsOHLC,
} from "./ohlc.js";
