/**
 * Candle Aggregation
 *
 * Shared logic for aggregating trades into OHLCV candles with order flow metrics.
 * Used by both streaming (tbbo-aggregator) and historical (historical-tbbo) processors.
 */

import type { CandleState, NormalizedTrade } from "./types.js";
import { getLargeTradeThreshold } from "./thresholds.js";

/**
 * Create a new empty candle state from a trade
 *
 * @param trade - The first trade for this candle
 * @returns New CandleState initialized with the trade data
 */
export function createCandleFromTrade(trade: NormalizedTrade): CandleState {
  const { price, size, isAsk, isBid, symbol, bidPrice, askPrice, bidSize, askSize, ticker } = trade;

  // Calculate spread and midpoint for this trade
  const spread = askPrice > 0 && bidPrice > 0 ? askPrice - bidPrice : 0;
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
  const spread = askPrice > 0 && bidPrice > 0 ? askPrice - bidPrice : 0;
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
