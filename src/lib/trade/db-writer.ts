/**
 * Database Writer for Candles
 *
 * Shared logic for writing candles to the database.
 * Used by both streaming (tbbo-aggregator) and historical (historical-tbbo) processors.
 *
 * Schema: 18 columns. Only price and CVD have OHLC. All other metrics are raw
 * building blocks that aggregate cleanly via sum/max. Derived ratios (vd_ratio,
 * book_imbalance, price_pct) are calculated at query time.
 */

import type { CandleForDb, CandleState } from "./types.js";
import { calculateVd } from "../metrics/index.js";

/** Number of columns in the candles INSERT statement */
export const COLUMNS_PER_ROW = 18;

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
      time, ticker,
      open, high, low, close, volume,
      ask_volume, bid_volume,
      cvd_open, cvd_high, cvd_low, cvd_close,
      vd,
      trades, max_trade_size, big_trades, big_volume
    )
    VALUES ${placeholders.join(", ")}
    ON CONFLICT (ticker, time) DO UPDATE SET
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
      -- Volume Delta
      vd = EXCLUDED.vd,
      -- Activity
      trades = EXCLUDED.trades,
      max_trade_size = GREATEST(${tableName}.max_trade_size, EXCLUDED.max_trade_size),
      big_trades = EXCLUDED.big_trades,
      big_volume = EXCLUDED.big_volume
    WHERE EXCLUDED.volume >= ${tableName}.volume
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
  const vd = candle.askVolume - candle.bidVolume;

  return [
    time,
    ticker,
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
    // Volume Delta
    vd,
    // Activity
    candle.tradeCount,
    candle.maxTradeSize,
    candle.largeTradeCount,
    candle.largeTradeVolume,
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
  const vd = candle.askVolume - candle.bidVolume;

  return [
    time,
    ticker,
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
    // Volume Delta
    vd,
    // Activity
    candle.tradeCount,
    candle.maxTradeSize,
    candle.largeTradeCount,
    candle.largeTradeVolume,
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
