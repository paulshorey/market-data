/**
 * Calculate All Order Flow Metrics
 *
 * Main function to compute all metrics in one call from candle data.
 */

import type { OrderFlowMetrics, OrderFlowInput } from "./types.js";
import { calculateVd, calculateVdRatio } from "./direction.js";
import { calculateBookImbalance } from "./book-imbalance.js";
import { calculatePricePct } from "./price.js";
import { calculateDivergence } from "./absorption.js";

/**
 * Calculate all order flow metrics from candle data
 *
 * Returns a complete OrderFlowMetrics object for database storage.
 *
 * Metrics calculated:
 * - Aggressive flow: vd, vdRatio (market orders)
 * - Passive flow: bookImbalance (limit orders waiting)
 * - Price: pricePct
 * - Activity: trades
 * - Large trades: maxTradeSize, bigTrades, bigVolume
 * - Absorption: divergence
 *
 * @param input - All candle data needed for metric calculation
 * @returns Complete OrderFlowMetrics object
 */
export function calculateOrderFlowMetrics(input: OrderFlowInput): OrderFlowMetrics {
  const {
    open,
    close,
    volume,
    askVolume,
    bidVolume,
    sumBidDepth,
    sumAskDepth,
    tradeCount,
    maxTradeSize,
    largeTradeCount,
    largeTradeVolume,
  } = input;

  // Aggressive order flow
  const vd = calculateVd(askVolume, bidVolume);
  const vdRatio = calculateVdRatio(askVolume, bidVolume);

  // Passive order flow
  const bookImbalance = calculateBookImbalance(sumBidDepth, sumAskDepth);

  // Price metrics
  const pricePct = calculatePricePct(open, close);

  // Activity metrics
  const trades = tradeCount;

  // Large trade metrics (passed through from aggregation)
  const bigTrades = largeTradeCount;
  const bigVolume = largeTradeVolume;

  // Absorption detection (using normalized values for better thresholding)
  const divergence = calculateDivergence(pricePct, vdRatio);

  return {
    vd,
    vdRatio,
    bookImbalance,
    pricePct,
    trades,
    maxTradeSize,
    bigTrades,
    bigVolume,
    divergence,
  };
}
