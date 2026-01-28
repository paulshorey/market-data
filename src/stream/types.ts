/**
 * Type definitions for TBBO streaming and candle aggregation
 *
 * This file re-exports types from the modular library for backward compatibility.
 * New code should import directly from ../lib/trade/types.js
 */

export type {
  TbboRecord,
  CandleState,
  CandleForDb,
  AggregatorStats,
  NormalizedTrade,
  MetricCalculationContext,
} from "../lib/trade/types.js";
