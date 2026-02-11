/**
 * Database Writer for Candles
 *
 * Shared logic for writing candles to the database.
 * Used by both streaming (tbbo-aggregator) and historical (historical-tbbo) processors.
 *
 * Schema: 28 columns. Price and CVD have OHLC. Derived metrics (vd_ratio,
 * book_imbalance, price_pct, divergence, vwap) are calculated at write time
 * from the candle's raw aggregation state. Raw accumulators (sum_bid_depth,
 * sum_ask_depth, sum_price_volume, unknown_volume) are stored for correct
 * higher-timeframe aggregation.
 */

import type { CandleForDb, CandleState } from "./types.js";
import { calculateVd, calculateVdRatio } from "../metrics/index.js";
import { calculateBookImbalance } from "../metrics/book-imbalance.js";
import { calculatePricePct } from "../metrics/price.js";
import { calculateDivergence } from "../metrics/absorption.js";

/** Number of columns in the candles INSERT statement */
export const COLUMNS_PER_ROW = 28;

/**
 * Build placeholder string for parameterized query
 * @param offset - Starting parameter number (0-based index * COLUMNS_PER_ROW)
 * @param count - Number of columns
 */
export function buildPlaceholder(offset: number, count: number): string {
  const parts: string[] = [];
  for (let i = 1; i <= count; i++) {
    parts.push(`$${offset + i}`);
  }
  return `(${parts.join(", ")})`;
}

/**
 * Build the INSERT query for candles
 * @param tableName - Target table name (e.g., "candles_1s")
 * @param placeholders - Array of placeholder strings from buildPlaceholder
 */
export function buildCandleInsertQuery(tableName: string, placeholders: string[]): string {
  return `
    INSERT INTO ${tableName} (
      time, ticker, symbol,
      open, high, low, close, volume,
      ask_volume, bid_volume,
      cvd_open, cvd_high, cvd_low, cvd_close,
      vd, vd_ratio, book_imbalance, price_pct, divergence,
      trades, max_trade_size, big_trades, big_volume,
      sum_bid_depth, sum_ask_depth, sum_price_volume, unknown_volume, vwap
    )
    VALUES ${placeholders.join(", ")}
    ON CONFLICT (ticker, time) DO UPDATE SET
      -- Symbol: always use latest
      symbol = EXCLUDED.symbol,
      -- Price OHLC: preserve open, update high/low/close
      open = ${tableName}.open,
      high = GREATEST(${tableName}.high, EXCLUDED.high),
      low = LEAST(${tableName}.low, EXCLUDED.low),
      close = EXCLUDED.close,
      volume = EXCLUDED.volume,
      -- Volume breakdown
      ask_volume = EXCLUDED.ask_volume,
      bid_volume = EXCLUDED.bid_volume,
      -- CVD OHLC
      cvd_open = COALESCE(${tableName}.cvd_open, EXCLUDED.cvd_open),
      cvd_high = GREATEST(COALESCE(${tableName}.cvd_high, EXCLUDED.cvd_high), EXCLUDED.cvd_high),
      cvd_low = LEAST(COALESCE(${tableName}.cvd_low, EXCLUDED.cvd_low), EXCLUDED.cvd_low),
      cvd_close = EXCLUDED.cvd_close,
      -- Volume Delta & derived metrics
      vd = EXCLUDED.vd,
      vd_ratio = EXCLUDED.vd_ratio,
      book_imbalance = EXCLUDED.book_imbalance,
      price_pct = EXCLUDED.price_pct,
      divergence = EXCLUDED.divergence,
      -- Activity
      trades = EXCLUDED.trades,
      max_trade_size = GREATEST(${tableName}.max_trade_size, EXCLUDED.max_trade_size),
      big_trades = EXCLUDED.big_trades,
      big_volume = EXCLUDED.big_volume,
      -- Raw accumulators
      sum_bid_depth = EXCLUDED.sum_bid_depth,
      sum_ask_depth = EXCLUDED.sum_ask_depth,
      sum_price_volume = EXCLUDED.sum_price_volume,
      unknown_volume = EXCLUDED.unknown_volume,
      vwap = EXCLUDED.vwap
    WHERE EXCLUDED.volume >= ${tableName}.volume
  `;
}

/**
 * Calculate derived metrics from candle state.
 * Used by both fallback and OHLC row builders.
 */
function calculateDerivedMetrics(candle: CandleState) {
  const vd = candle.askVolume - candle.bidVolume;
  const vdRatio = calculateVdRatio(candle.askVolume, candle.bidVolume);
  const bookImbalance = calculateBookImbalance(candle.sumBidDepth, candle.sumAskDepth);
  const pricePct = calculatePricePct(candle.open, candle.close);
  const divergence = calculateDivergence(pricePct, vdRatio);
  const vwap = candle.volume > 0 ? candle.sumPriceVolume / candle.volume : null;
  return { vd, vdRatio, bookImbalance, pricePct, divergence, vwap };
}

/**
 * Build values array for a single candle row (fallback when no metricsOHLC)
 * Used when a candle doesn't have OHLC tracking (shouldn't normally happen)
 */
export function buildFallbackRowValues(
  time: string,
  ticker: string,
  candle: CandleState,
  cvd: number
): (string | number | null)[] {
  const { vd, vdRatio, bookImbalance, pricePct, divergence, vwap } = calculateDerivedMetrics(candle);

  return [
    time,
    ticker,
    candle.symbol,
    candle.open,
    candle.high,
    candle.low,
    candle.close,
    candle.volume,
    // Volume breakdown
    candle.askVolume,
    candle.bidVolume,
    // CVD OHLC (all same since no tracking)
    cvd,
    cvd,
    cvd,
    cvd,
    // Volume Delta & derived metrics
    vd,
    vdRatio,
    bookImbalance,
    pricePct,
    divergence,
    // Activity
    candle.tradeCount,
    candle.maxTradeSize,
    candle.largeTradeCount,
    candle.largeTradeVolume,
    // Raw accumulators for higher-timeframe aggregation
    candle.sumBidDepth,
    candle.sumAskDepth,
    candle.sumPriceVolume,
    candle.unknownSideVolume,
    vwap,
  ];
}

/**
 * Build values array for a single candle row with metricsOHLC
 */
export function buildOhlcRowValues(
  time: string,
  ticker: string,
  candle: CandleState
): (string | number | null)[] {
  const m = candle.metricsOHLC!;
  const { vd, vdRatio, bookImbalance, pricePct, divergence, vwap } = calculateDerivedMetrics(candle);

  return [
    time,
    ticker,
    candle.symbol,
    candle.open,
    candle.high,
    candle.low,
    candle.close,
    candle.volume,
    // Volume breakdown
    candle.askVolume,
    candle.bidVolume,
    // CVD OHLC (tracked throughout the candle)
    m.cvd.open,
    m.cvd.high,
    m.cvd.low,
    m.cvd.close,
    // Volume Delta & derived metrics
    vd,
    vdRatio,
    bookImbalance,
    pricePct,
    divergence,
    // Activity
    candle.tradeCount,
    candle.maxTradeSize,
    candle.largeTradeCount,
    candle.largeTradeVolume,
    // Raw accumulators for higher-timeframe aggregation
    candle.sumBidDepth,
    candle.sumAskDepth,
    candle.sumPriceVolume,
    candle.unknownSideVolume,
    vwap,
  ];
}

/**
 * Context for CVD calculation during batch writes
 */
export interface CvdContext {
  /** Get base CVD for a ticker */
  getBaseCvd: (ticker: string) => number;
  /** Update CVD after processing a candle */
  updateCvd?: (ticker: string, newCvd: number) => void;
}

/**
 * Build INSERT parameters for a batch of candles
 *
 * @param candles - Array of candles to insert
 * @param cvdContext - Context for CVD calculations
 * @returns Object with values array and placeholders array
 */
export function buildCandleInsertParams(
  candles: CandleForDb[],
  cvdContext: CvdContext
): {
  values: (string | number | null)[];
  placeholders: string[];
} {
  const values: (string | number | null)[] = [];
  const placeholders: string[] = [];

  candles.forEach(({ ticker, time, candle }, i) => {
    const m = candle.metricsOHLC;
    const offset = i * COLUMNS_PER_ROW;

    placeholders.push(buildPlaceholder(offset, COLUMNS_PER_ROW));

    if (!m) {
      // Fallback: no metricsOHLC, calculate CVD from base
      const baseCvd = cvdContext.getBaseCvd(ticker);
      const vd = calculateVd(candle.askVolume, candle.bidVolume);
      const cvd = baseCvd + vd;
      cvdContext.updateCvd?.(ticker, cvd);

      values.push(...buildFallbackRowValues(time, ticker, candle, cvd));
    } else {
      // Has metricsOHLC - use it
      cvdContext.updateCvd?.(ticker, m.cvd.close);
      values.push(...buildOhlcRowValues(time, ticker, candle));
    }
  });

  return { values, placeholders };
}
