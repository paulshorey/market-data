/**
 * Database Writer for Candles
 *
 * Shared logic for writing candles to the database.
 * Used by both streaming (tbbo-aggregator) and historical (historical-tbbo) processors.
 *
 * Simplified schema: only CVD retains OHLC. All other metrics are single values.
 */

import type { CandleForDb, CandleState } from "./types.js";
import { calculateOrderFlowMetrics, calculateDivergence } from "../metrics/index.js";

/** Number of columns in the candles INSERT statement */
export const COLUMNS_PER_ROW = 21;

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
 */
export function buildCandleInsertQuery(placeholders: string[]): string {
  return `
    INSERT INTO "candles-1m" (
      time, ticker, symbol, open, high, low, close, volume,
      -- CVD OHLC (only metric with OHLC tracking)
      cvd_open, cvd_high, cvd_low, cvd_close,
      -- Single-value order flow metrics
      vd, vd_ratio, book_imbalance, price_pct,
      -- Activity metrics
      trades, max_trade_size, big_trades, big_volume, divergence
    )
    VALUES ${placeholders.join(", ")}
    ON CONFLICT (ticker, time) DO UPDATE SET
      symbol = EXCLUDED.symbol,
      -- Price OHLC: preserve open, update high/low/close
      open = "candles-1m".open,
      high = GREATEST("candles-1m".high, EXCLUDED.high),
      low = LEAST("candles-1m".low, EXCLUDED.low),
      close = EXCLUDED.close,
      volume = EXCLUDED.volume,
      -- CVD OHLC
      cvd_open = COALESCE("candles-1m".cvd_open, EXCLUDED.cvd_open),
      cvd_high = GREATEST(COALESCE("candles-1m".cvd_high, EXCLUDED.cvd_high), EXCLUDED.cvd_high),
      cvd_low = LEAST(COALESCE("candles-1m".cvd_low, EXCLUDED.cvd_low), EXCLUDED.cvd_low),
      cvd_close = EXCLUDED.cvd_close,
      -- Single-value metrics (always use latest)
      vd = EXCLUDED.vd,
      vd_ratio = EXCLUDED.vd_ratio,
      book_imbalance = EXCLUDED.book_imbalance,
      price_pct = EXCLUDED.price_pct,
      -- Activity metrics
      trades = EXCLUDED.trades,
      max_trade_size = GREATEST("candles-1m".max_trade_size, EXCLUDED.max_trade_size),
      big_trades = EXCLUDED.big_trades,
      big_volume = EXCLUDED.big_volume,
      divergence = EXCLUDED.divergence
    WHERE EXCLUDED.volume >= "candles-1m".volume
  `;
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
  const finalMetrics = calculateOrderFlowMetrics({
    open: candle.open,
    close: candle.close,
    volume: candle.volume,
    askVolume: candle.askVolume,
    bidVolume: candle.bidVolume,
    sumBidDepth: candle.sumBidDepth,
    sumAskDepth: candle.sumAskDepth,
    tradeCount: candle.tradeCount,
    maxTradeSize: candle.maxTradeSize,
    largeTradeCount: candle.largeTradeCount,
    largeTradeVolume: candle.largeTradeVolume,
  });

  return [
    time,
    ticker,
    candle.symbol,
    candle.open,
    candle.high,
    candle.low,
    candle.close,
    candle.volume,
    // CVD OHLC (all same since no tracking)
    cvd,
    cvd,
    cvd,
    cvd,
    // Single-value metrics
    finalMetrics.vd,
    finalMetrics.vdRatio,
    finalMetrics.bookImbalance,
    finalMetrics.pricePct,
    // Activity metrics
    candle.tradeCount,
    candle.maxTradeSize,
    candle.largeTradeCount,
    candle.largeTradeVolume,
    finalMetrics.divergence,
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

  // Calculate final metrics from raw candle state
  const finalMetrics = calculateOrderFlowMetrics({
    open: candle.open,
    close: candle.close,
    volume: candle.volume,
    askVolume: candle.askVolume,
    bidVolume: candle.bidVolume,
    sumBidDepth: candle.sumBidDepth,
    sumAskDepth: candle.sumAskDepth,
    tradeCount: candle.tradeCount,
    maxTradeSize: candle.maxTradeSize,
    largeTradeCount: candle.largeTradeCount,
    largeTradeVolume: candle.largeTradeVolume,
  });

  return [
    time,
    ticker,
    candle.symbol,
    candle.open,
    candle.high,
    candle.low,
    candle.close,
    candle.volume,
    // CVD OHLC (tracked throughout the minute)
    m.cvd.open,
    m.cvd.high,
    m.cvd.low,
    m.cvd.close,
    // Single-value metrics (calculated from final candle state)
    finalMetrics.vd,
    finalMetrics.vdRatio,
    finalMetrics.bookImbalance,
    finalMetrics.pricePct,
    // Activity metrics
    candle.tradeCount,
    candle.maxTradeSize,
    candle.largeTradeCount,
    candle.largeTradeVolume,
    finalMetrics.divergence,
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
      // Fallback: no metricsOHLC, calculate final values
      const baseCvd = cvdContext.getBaseCvd(ticker);

      // Calculate VD to get CVD
      const finalMetrics = calculateOrderFlowMetrics({
        open: candle.open,
        close: candle.close,
        volume: candle.volume,
        askVolume: candle.askVolume,
        bidVolume: candle.bidVolume,
        sumBidDepth: candle.sumBidDepth,
        sumAskDepth: candle.sumAskDepth,
        tradeCount: candle.tradeCount,
        maxTradeSize: candle.maxTradeSize,
        largeTradeCount: candle.largeTradeCount,
        largeTradeVolume: candle.largeTradeVolume,
      });

      const cvd = baseCvd + finalMetrics.vd;
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
