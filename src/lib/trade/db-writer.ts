/**
 * Database Writer for Candles
 *
 * Shared logic for writing candles to the database with OHLC metrics.
 * Used by both streaming (tbbo-aggregator) and historical (historical-tbbo) processors.
 */

import type { CandleForDb, CandleState } from "./types.js";
import { calculateOrderFlowMetrics, calculateDivergence } from "../metrics/index.js";

/** Number of columns in the candles INSERT statement */
export const COLUMNS_PER_ROW = 54;

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
 * Build the INSERT query for candles with OHLC metrics
 */
export function buildCandleInsertQuery(placeholders: string[]): string {
  return `
    INSERT INTO "candles-1m" (
      time, ticker, symbol, open, high, low, close, volume,
      -- VD OHLC
      vd_open, vd_high, vd_low, vd_close,
      -- CVD OHLC
      cvd_open, cvd_high, cvd_low, cvd_close,
      -- VD Ratio OHLC
      vd_ratio_open, vd_ratio_high, vd_ratio_low, vd_ratio_close,
      -- Book Imbalance OHLC
      book_imbalance_open, book_imbalance_high, book_imbalance_low, book_imbalance_close,
      -- VWAP OHLC
      vwap_open, vwap_high, vwap_low, vwap_close,
      -- Spread BPS OHLC
      spread_bps_open, spread_bps_high, spread_bps_low, spread_bps_close,
      -- Price Pct OHLC
      price_pct_open, price_pct_high, price_pct_low, price_pct_close,
      -- Avg Trade Size OHLC
      avg_trade_size_open, avg_trade_size_high, avg_trade_size_low, avg_trade_size_close,
      -- EVR OHLC
      evr_open, evr_high, evr_low, evr_close,
      -- SMP OHLC
      smp_open, smp_high, smp_low, smp_close,
      -- Non-OHLC metrics
      trades, max_trade_size, big_trades, big_volume, divergence, vd_strength
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
      -- VD OHLC
      vd_open = COALESCE("candles-1m".vd_open, EXCLUDED.vd_open),
      vd_high = GREATEST(COALESCE("candles-1m".vd_high, EXCLUDED.vd_high), EXCLUDED.vd_high),
      vd_low = LEAST(COALESCE("candles-1m".vd_low, EXCLUDED.vd_low), EXCLUDED.vd_low),
      vd_close = EXCLUDED.vd_close,
      -- CVD OHLC
      cvd_open = COALESCE("candles-1m".cvd_open, EXCLUDED.cvd_open),
      cvd_high = GREATEST(COALESCE("candles-1m".cvd_high, EXCLUDED.cvd_high), EXCLUDED.cvd_high),
      cvd_low = LEAST(COALESCE("candles-1m".cvd_low, EXCLUDED.cvd_low), EXCLUDED.cvd_low),
      cvd_close = EXCLUDED.cvd_close,
      -- VD Ratio OHLC
      vd_ratio_open = COALESCE("candles-1m".vd_ratio_open, EXCLUDED.vd_ratio_open),
      vd_ratio_high = GREATEST(COALESCE("candles-1m".vd_ratio_high, EXCLUDED.vd_ratio_high), EXCLUDED.vd_ratio_high),
      vd_ratio_low = LEAST(COALESCE("candles-1m".vd_ratio_low, EXCLUDED.vd_ratio_low), EXCLUDED.vd_ratio_low),
      vd_ratio_close = EXCLUDED.vd_ratio_close,
      -- Book Imbalance OHLC
      book_imbalance_open = COALESCE("candles-1m".book_imbalance_open, EXCLUDED.book_imbalance_open),
      book_imbalance_high = GREATEST(COALESCE("candles-1m".book_imbalance_high, EXCLUDED.book_imbalance_high), EXCLUDED.book_imbalance_high),
      book_imbalance_low = LEAST(COALESCE("candles-1m".book_imbalance_low, EXCLUDED.book_imbalance_low), EXCLUDED.book_imbalance_low),
      book_imbalance_close = EXCLUDED.book_imbalance_close,
      -- VWAP OHLC
      vwap_open = COALESCE("candles-1m".vwap_open, EXCLUDED.vwap_open),
      vwap_high = GREATEST(COALESCE("candles-1m".vwap_high, EXCLUDED.vwap_high), EXCLUDED.vwap_high),
      vwap_low = LEAST(COALESCE("candles-1m".vwap_low, EXCLUDED.vwap_low), EXCLUDED.vwap_low),
      vwap_close = EXCLUDED.vwap_close,
      -- Spread BPS OHLC
      spread_bps_open = COALESCE("candles-1m".spread_bps_open, EXCLUDED.spread_bps_open),
      spread_bps_high = GREATEST(COALESCE("candles-1m".spread_bps_high, EXCLUDED.spread_bps_high), EXCLUDED.spread_bps_high),
      spread_bps_low = LEAST(COALESCE("candles-1m".spread_bps_low, EXCLUDED.spread_bps_low), EXCLUDED.spread_bps_low),
      spread_bps_close = EXCLUDED.spread_bps_close,
      -- Price Pct OHLC
      price_pct_open = COALESCE("candles-1m".price_pct_open, EXCLUDED.price_pct_open),
      price_pct_high = GREATEST(COALESCE("candles-1m".price_pct_high, EXCLUDED.price_pct_high), EXCLUDED.price_pct_high),
      price_pct_low = LEAST(COALESCE("candles-1m".price_pct_low, EXCLUDED.price_pct_low), EXCLUDED.price_pct_low),
      price_pct_close = EXCLUDED.price_pct_close,
      -- Avg Trade Size OHLC
      avg_trade_size_open = COALESCE("candles-1m".avg_trade_size_open, EXCLUDED.avg_trade_size_open),
      avg_trade_size_high = GREATEST(COALESCE("candles-1m".avg_trade_size_high, EXCLUDED.avg_trade_size_high), EXCLUDED.avg_trade_size_high),
      avg_trade_size_low = LEAST(COALESCE("candles-1m".avg_trade_size_low, EXCLUDED.avg_trade_size_low), EXCLUDED.avg_trade_size_low),
      avg_trade_size_close = EXCLUDED.avg_trade_size_close,
      -- EVR OHLC
      evr_open = COALESCE("candles-1m".evr_open, EXCLUDED.evr_open),
      evr_high = GREATEST(COALESCE("candles-1m".evr_high, EXCLUDED.evr_high), EXCLUDED.evr_high),
      evr_low = LEAST(COALESCE("candles-1m".evr_low, EXCLUDED.evr_low), EXCLUDED.evr_low),
      evr_close = EXCLUDED.evr_close,
      -- SMP OHLC
      smp_open = COALESCE("candles-1m".smp_open, EXCLUDED.smp_open),
      smp_high = GREATEST(COALESCE("candles-1m".smp_high, EXCLUDED.smp_high), EXCLUDED.smp_high),
      smp_low = LEAST(COALESCE("candles-1m".smp_low, EXCLUDED.smp_low), EXCLUDED.smp_low),
      smp_close = EXCLUDED.smp_close,
      -- Non-OHLC metrics
      trades = EXCLUDED.trades,
      max_trade_size = GREATEST("candles-1m".max_trade_size, EXCLUDED.max_trade_size),
      big_trades = EXCLUDED.big_trades,
      big_volume = EXCLUDED.big_volume,
      divergence = EXCLUDED.divergence,
      vd_strength = EXCLUDED.vd_strength
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
  cvd: number,
  vdStrength: number = 1
): (string | number | null)[] {
  const finalMetrics = calculateOrderFlowMetrics({
    open: candle.open,
    close: candle.close,
    volume: candle.volume,
    askVolume: candle.askVolume,
    bidVolume: candle.bidVolume,
    sumBidDepth: candle.sumBidDepth,
    sumAskDepth: candle.sumAskDepth,
    sumSpread: candle.sumSpread,
    sumMidPrice: candle.sumMidPrice,
    sumPriceVolume: candle.sumPriceVolume,
    tradeCount: candle.tradeCount,
    maxTradeSize: candle.maxTradeSize,
    largeTradeCount: candle.largeTradeCount,
    largeTradeVolume: candle.largeTradeVolume,
    vdStrength,
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
    // VD OHLC (all same since no tracking)
    finalMetrics.vd,
    finalMetrics.vd,
    finalMetrics.vd,
    finalMetrics.vd,
    // CVD OHLC
    cvd,
    cvd,
    cvd,
    cvd,
    // VD Ratio OHLC
    finalMetrics.vdRatio,
    finalMetrics.vdRatio,
    finalMetrics.vdRatio,
    finalMetrics.vdRatio,
    // Book Imbalance OHLC
    finalMetrics.bookImbalance,
    finalMetrics.bookImbalance,
    finalMetrics.bookImbalance,
    finalMetrics.bookImbalance,
    // VWAP OHLC
    finalMetrics.vwap,
    finalMetrics.vwap,
    finalMetrics.vwap,
    finalMetrics.vwap,
    // Spread BPS OHLC
    finalMetrics.spreadBps,
    finalMetrics.spreadBps,
    finalMetrics.spreadBps,
    finalMetrics.spreadBps,
    // Price Pct OHLC
    finalMetrics.pricePct,
    finalMetrics.pricePct,
    finalMetrics.pricePct,
    finalMetrics.pricePct,
    // Avg Trade Size OHLC
    finalMetrics.avgTradeSize,
    finalMetrics.avgTradeSize,
    finalMetrics.avgTradeSize,
    finalMetrics.avgTradeSize,
    // EVR OHLC
    finalMetrics.evr,
    finalMetrics.evr,
    finalMetrics.evr,
    finalMetrics.evr,
    // SMP OHLC
    finalMetrics.smp,
    finalMetrics.smp,
    finalMetrics.smp,
    finalMetrics.smp,
    // Non-OHLC metrics
    candle.tradeCount,
    candle.maxTradeSize,
    candle.largeTradeCount,
    candle.largeTradeVolume,
    finalMetrics.divergence,
    finalMetrics.vdStrength,
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

  // Calculate divergence from final values
  const divergence = calculateDivergence(m.pricePct.close, m.vdRatio.close);

  return [
    time,
    ticker,
    candle.symbol,
    candle.open,
    candle.high,
    candle.low,
    candle.close,
    candle.volume,
    // VD OHLC
    m.vd.open,
    m.vd.high,
    m.vd.low,
    m.vd.close,
    // CVD OHLC
    m.cvd.open,
    m.cvd.high,
    m.cvd.low,
    m.cvd.close,
    // VD Ratio OHLC
    m.vdRatio.open,
    m.vdRatio.high,
    m.vdRatio.low,
    m.vdRatio.close,
    // Book Imbalance OHLC
    m.bookImbalance.open,
    m.bookImbalance.high,
    m.bookImbalance.low,
    m.bookImbalance.close,
    // VWAP OHLC
    m.vwap.open,
    m.vwap.high,
    m.vwap.low,
    m.vwap.close,
    // Spread BPS OHLC
    m.spreadBps.open,
    m.spreadBps.high,
    m.spreadBps.low,
    m.spreadBps.close,
    // Price Pct OHLC
    m.pricePct.open,
    m.pricePct.high,
    m.pricePct.low,
    m.pricePct.close,
    // Avg Trade Size OHLC
    m.avgTradeSize.open,
    m.avgTradeSize.high,
    m.avgTradeSize.low,
    m.avgTradeSize.close,
    // EVR OHLC
    m.evr.open,
    m.evr.high,
    m.evr.low,
    m.evr.close,
    // SMP OHLC
    m.smp.open,
    m.smp.high,
    m.smp.low,
    m.smp.close,
    // Non-OHLC metrics
    candle.tradeCount,
    candle.maxTradeSize,
    candle.largeTradeCount,
    candle.largeTradeVolume,
    divergence,
    candle.vdStrength ?? 1,
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
      const vdStrength = candle.vdStrength ?? 1;

      // Calculate VD to get CVD
      const finalMetrics = calculateOrderFlowMetrics({
        open: candle.open,
        close: candle.close,
        volume: candle.volume,
        askVolume: candle.askVolume,
        bidVolume: candle.bidVolume,
        sumBidDepth: candle.sumBidDepth,
        sumAskDepth: candle.sumAskDepth,
        sumSpread: candle.sumSpread,
        sumMidPrice: candle.sumMidPrice,
        sumPriceVolume: candle.sumPriceVolume,
        tradeCount: candle.tradeCount,
        maxTradeSize: candle.maxTradeSize,
        largeTradeCount: candle.largeTradeCount,
        largeTradeVolume: candle.largeTradeVolume,
        vdStrength,
      });

      const cvd = baseCvd + finalMetrics.vd;
      cvdContext.updateCvd?.(ticker, cvd);

      values.push(...buildFallbackRowValues(time, ticker, candle, cvd, vdStrength));
    } else {
      // Has metricsOHLC - use it
      cvdContext.updateCvd?.(ticker, m.cvd.close);
      values.push(...buildOhlcRowValues(time, ticker, candle));
    }
  });

  return { values, placeholders };
}
