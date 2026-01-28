/**
 * Calculate All Order Flow Metrics
 *
 * Main function to compute all metrics in one call from candle data.
 */

import type { OrderFlowMetrics, OrderFlowInput } from "./types.js";
import { calculateVd, calculateVdRatio } from "./direction.js";
import { calculateBookImbalance } from "./book-imbalance.js";
import { calculatePricePct, calculateVwap, calculateSpreadBps } from "./price.js";
import { calculateAvgTradeSize } from "./activity.js";
import { calculateDivergence, calculateEvr } from "./absorption.js";
import { calculateSmp } from "./composite.js";

/**
 * Calculate all order flow metrics from candle data
 *
 * This is the main function to compute all metrics in one call.
 * It returns a complete OrderFlowMetrics object for database storage.
 *
 * Metrics calculated:
 * - Aggressive flow: vd, vdRatio (market orders)
 * - Passive flow: bookImbalance (limit orders waiting)
 * - Price: pricePct, vwap
 * - Liquidity: spreadBps
 * - Activity: trades, avgTradeSize
 * - Large trades: maxTradeSize, bigTrades, bigVolume
 * - Absorption: divergence, evr
 * - Composite: smp (smart money pressure)
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
    sumSpread,
    sumMidPrice,
    sumPriceVolume,
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
  const vwap = calculateVwap(sumPriceVolume, volume);

  // Liquidity
  const spreadBps = calculateSpreadBps(sumSpread, sumMidPrice, tradeCount);

  // Activity metrics
  const trades = tradeCount;
  const avgTradeSize = calculateAvgTradeSize(volume, tradeCount);

  // Large trade metrics (passed through from aggregation)
  const bigTrades = largeTradeCount;
  const bigVolume = largeTradeVolume;

  // Momentum (from rolling history, default to 1 if not provided)
  const vdStrength = input.vdStrength ?? 1;

  // Absorption detection (using normalized values for better thresholding)
  const divergence = calculateDivergence(pricePct, vdRatio);
  const evr = calculateEvr(pricePct, vdRatio);

  // Smart Money Pressure: Composite institutional-weighted score
  // Now also factors in momentum strength
  const smp = calculateSmp({
    vdRatio,
    bookImbalance,
    bigVolume,
    volume,
    evr,
    divergence,
    spreadBps,
    vdStrength, // Add momentum to SMP calculation
  });

  return {
    vd,
    vdRatio,
    bookImbalance,
    pricePct,
    vwap,
    spreadBps,
    trades,
    avgTradeSize,
    maxTradeSize,
    bigTrades,
    bigVolume,
    divergence,
    evr,
    smp,
    vdStrength,
  };
}
