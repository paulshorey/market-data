/**
 * Candle Aggregation
 *
 * Shared logic for aggregating trades into OHLCV candles with order flow metrics.
 * Used by both streaming (tbbo-aggregator) and historical (historical-tbbo) processors.
 */

import type { CandleState, NormalizedTrade, MetricCalculationContext } from "./types.js";
import { getLargeTradeThreshold } from "./thresholds.js";
import {
  calculateVd,
  calculateVdRatio,
  calculateBookImbalance,
  calculateVwap,
  calculateSpreadBps,
  calculatePricePct,
  calculateAvgTradeSize,
  calculateEvr,
  calculateSmp,
} from "../metrics/index.js";
import { initAllMetricsOHLC, updateAllMetricsOHLC } from "../metrics/ohlc.js";

/**
 * Create a new empty candle state from a trade
 *
 * @param trade - The first trade for this candle
 * @returns New CandleState initialized with the trade data
 */
export function createCandleFromTrade(trade: NormalizedTrade): CandleState {
  const { price, size, isAsk, isBid, symbol, bidPrice, askPrice, bidSize, askSize, ticker } = trade;

  // Calculate spread and midpoint for this trade
  // Use Math.abs() because in crossed/inverted markets bid can exceed ask
  const spread = askPrice > 0 && bidPrice > 0 ? Math.abs(askPrice - bidPrice) : 0;
  const midPrice = askPrice > 0 && bidPrice > 0 ? (askPrice + bidPrice) / 2 : price;

  // Check if this is a large trade
  const largeTradeThreshold = getLargeTradeThreshold(ticker);
  const isLargeTrade = size >= largeTradeThreshold;

  return {
    // OHLCV
    open: price,
    high: price,
    low: price,
    close: price,
    volume: size,

    // Aggressive order flow
    askVolume: isAsk ? size : 0,
    bidVolume: isBid ? size : 0,
    unknownSideVolume: !isAsk && !isBid ? size : 0,

    // Passive order flow (book depth)
    sumBidDepth: bidSize || 0,
    sumAskDepth: askSize || 0,

    // Spread tracking
    sumSpread: spread,
    sumMidPrice: midPrice,

    // VWAP tracking
    sumPriceVolume: price * size,

    // Large trade detection
    maxTradeSize: size,
    largeTradeCount: isLargeTrade ? 1 : 0,
    largeTradeVolume: isLargeTrade ? size : 0,

    symbol,
    tradeCount: 1,

    // metricsOHLC will be initialized by updateCandleMetricsOHLC
  };
}

/**
 * Update an existing candle with a new trade
 *
 * @param candle - The existing candle state to update
 * @param trade - The trade to add to the candle
 */
export function updateCandleWithTrade(candle: CandleState, trade: NormalizedTrade): void {
  const { price, size, isAsk, isBid, symbol, bidPrice, askPrice, bidSize, askSize, ticker } = trade;

  // Calculate spread and midpoint for this trade
  // Use Math.abs() because in crossed/inverted markets bid can exceed ask
  const spread = askPrice > 0 && bidPrice > 0 ? Math.abs(askPrice - bidPrice) : 0;
  const midPrice = askPrice > 0 && bidPrice > 0 ? (askPrice + bidPrice) / 2 : price;

  // Check if this is a large trade
  const largeTradeThreshold = getLargeTradeThreshold(ticker);
  const isLargeTrade = size >= largeTradeThreshold;

  // OHLCV
  candle.high = Math.max(candle.high, price);
  candle.low = Math.min(candle.low, price);
  candle.close = price;
  candle.volume += size;
  candle.symbol = symbol;
  candle.tradeCount++;

  // Aggressive order flow
  if (isAsk) candle.askVolume += size;
  else if (isBid) candle.bidVolume += size;
  else candle.unknownSideVolume += size;

  // Passive order flow (book depth)
  candle.sumBidDepth += bidSize || 0;
  candle.sumAskDepth += askSize || 0;

  // Spread tracking
  candle.sumSpread += spread;
  candle.sumMidPrice += midPrice;

  // VWAP tracking
  candle.sumPriceVolume += price * size;

  // Large trade detection
  candle.maxTradeSize = Math.max(candle.maxTradeSize, size);
  if (isLargeTrade) {
    candle.largeTradeCount++;
    candle.largeTradeVolume += size;
  }
}

/**
 * Add a trade to a candle map, creating a new candle if needed
 *
 * @param candles - Map of key -> CandleState
 * @param key - The key for this candle (typically "ticker|minuteBucket")
 * @param trade - The normalized trade to add
 */
export function addTradeToCandle(
  candles: Map<string, CandleState>,
  key: string,
  trade: NormalizedTrade
): void {
  const existing = candles.get(key);

  if (existing) {
    updateCandleWithTrade(existing, trade);
  } else {
    candles.set(key, createCandleFromTrade(trade));
  }
}

/**
 * Calculate current metric values from candle state
 */
function calculateCurrentMetrics(
  candle: CandleState,
  baseCvd: number,
  vdStrength: number
): {
  vd: number;
  cvd: number;
  vdRatio: number;
  bookImbalance: number;
  vwap: number;
  spreadBps: number;
  pricePct: number;
  avgTradeSize: number;
  evr: number;
  smp: number;
} {
  // Calculate base metrics
  const vd = calculateVd(candle.askVolume, candle.bidVolume);
  const cvd = baseCvd + vd;
  const vdRatio = calculateVdRatio(candle.askVolume, candle.bidVolume);
  const bookImbalance = calculateBookImbalance(candle.sumBidDepth, candle.sumAskDepth);
  const vwap = calculateVwap(candle.sumPriceVolume, candle.volume);
  const spreadBps = calculateSpreadBps(candle.sumSpread, candle.sumMidPrice, candle.tradeCount);
  const pricePct = calculatePricePct(candle.open, candle.close);
  const avgTradeSize = calculateAvgTradeSize(candle.volume, candle.tradeCount);

  // Calculate EVR (may be null, convert to 0 for OHLC tracking)
  const evrRaw = calculateEvr(pricePct, vdRatio);
  const evr = evrRaw ?? 0;

  // Calculate SMP
  const smp = calculateSmp({
    vdRatio,
    bookImbalance,
    bigVolume: candle.largeTradeVolume,
    volume: candle.volume,
    evr: evrRaw,
    divergence: 0, // Divergence is calculated at the end
    spreadBps,
    vdStrength,
  });

  return {
    vd,
    cvd,
    vdRatio,
    bookImbalance,
    vwap,
    spreadBps,
    pricePct,
    avgTradeSize,
    evr,
    smp,
  };
}

/**
 * Update the metrics OHLC in a candle after a trade has been added.
 *
 * This should be called after each trade to track how metrics evolved
 * throughout the minute. The first call initializes the OHLC (setting open),
 * subsequent calls update high/low/close.
 *
 * @param candle - The candle state (must have trade data already added)
 * @param context - Context with base CVD and vdStrength from the aggregator
 */
export function updateCandleMetricsOHLC(
  candle: CandleState,
  context: MetricCalculationContext
): void {
  const { baseCvd, vdStrength } = context;

  // Calculate current metric values
  const metrics = calculateCurrentMetrics(candle, baseCvd, vdStrength);

  // Store current CVD and vdStrength in candle for later use
  candle.currentCvd = metrics.cvd;
  candle.vdStrength = vdStrength;

  // Initialize or update metrics OHLC
  if (!candle.metricsOHLC) {
    // First trade - initialize all OHLC with current values (sets open)
    candle.metricsOHLC = initAllMetricsOHLC(
      metrics.vd,
      metrics.cvd,
      metrics.vdRatio,
      metrics.bookImbalance,
      metrics.vwap,
      metrics.spreadBps,
      metrics.pricePct,
      metrics.avgTradeSize,
      metrics.evr,
      metrics.smp
    );
  } else {
    // Subsequent trades - update high/low/close
    updateAllMetricsOHLC(
      candle.metricsOHLC,
      metrics.vd,
      metrics.cvd,
      metrics.vdRatio,
      metrics.bookImbalance,
      metrics.vwap,
      metrics.spreadBps,
      metrics.pricePct,
      metrics.avgTradeSize,
      metrics.evr,
      metrics.smp
    );
  }
}

/**
 * Add a trade to a candle map and update metrics OHLC
 *
 * This is the complete function that:
 * 1. Adds the trade to the candle (or creates a new candle)
 * 2. Calculates current metrics
 * 3. Updates the metrics OHLC tracking
 *
 * @param candles - Map of key -> CandleState
 * @param key - The key for this candle (typically "ticker|minuteBucket")
 * @param trade - The normalized trade to add
 * @param context - Context with base CVD and vdStrength from the aggregator
 */
export function addTradeAndUpdateMetrics(
  candles: Map<string, CandleState>,
  key: string,
  trade: NormalizedTrade,
  context: MetricCalculationContext
): void {
  // Add the trade to the candle
  addTradeToCandle(candles, key, trade);

  // Update metrics OHLC
  const candle = candles.get(key)!;
  updateCandleMetricsOHLC(candle, context);
}
