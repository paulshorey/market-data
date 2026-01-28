/**
 * TBBO Aggregator
 *
 * Aggregates real-time TBBO (trade) data into 1-minute OHLCV candles
 * and writes them to the database every 1 second.
 *
 * Features:
 * - Volume Delta (VD): per-candle (askVolume - bidVolume)
 * - Cumulative Volume Delta (CVD): running total of VD across candles
 * - Order Flow Metrics with OHLC tracking:
 *   - Each metric tracks Open/High/Low/Close within the minute
 *   - Open: First value (set once)
 *   - High: Maximum value seen
 *   - Low: Minimum value seen
 *   - Close: Latest value (updated every second)
 * - Lee-Ready algorithm fallback for unknown trade sides
 * - Late trade rejection to prevent data corruption
 * - Graceful handling of DB write failures
 */

import { pool } from "../lib/db.js";

// Import types from trade library
import type {
  TbboRecord,
  CandleState,
  CandleForDb,
  AggregatorStats,
  NormalizedTrade,
  MetricCalculationContext,
} from "../lib/trade/index.js";

// Import trade processing utilities
import {
  MAX_TRADE_AGE_MS,
  nsToMs,
  getMinuteBucket,
  extractTicker,
  determineTradeSide,
  addTradeAndUpdateMetrics,
} from "../lib/trade/index.js";

// Import metrics calculations
import {
  calculateVd,
  calculateDivergence,
  MomentumTracker,
  calculateOrderFlowMetrics,
} from "../lib/metrics/index.js";

// Re-export TbboRecord for consumers that import from this file
export type { TbboRecord } from "../lib/trade/index.js";

// ============================================================================
// Main Aggregator Class
// ============================================================================

/**
 * Aggregates TBBO records into 1-minute candles with VD and CVD tracking
 */
export class TbboAggregator {
  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /** Map of ticker|timestamp -> CandleState for in-progress candles */
  private candles: Map<string, CandleState> = new Map();

  /** Cumulative Volume Delta per ticker - persists across minutes */
  private cvdByTicker: Map<string, number> = new Map();

  /** Momentum tracker for VD strength calculations */
  private momentumTracker = new MomentumTracker();

  /** Whether initialize() has been called */
  private initialized = false;

  // -------------------------------------------------------------------------
  // Statistics
  // -------------------------------------------------------------------------

  private recordsProcessed = 0;
  private candlesWritten = 0;
  private lastLogTime = Date.now();

  private stats = {
    lateTradesRejected: 0,
    unknownSideTrades: 0,
  };

  // =========================================================================
  // Lifecycle Methods
  // =========================================================================

  constructor() {
    console.log("📊 TBBO Aggregator created (call initialize() to load CVD from database)");
  }

  /**
   * Initialize the aggregator by loading last CVD values from database.
   * This ensures CVD continuity across server restarts.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      console.warn("⚠️ Aggregator already initialized");
      return;
    }

    try {
      const result = await pool.query(`
        SELECT DISTINCT ON (ticker) ticker, cvd_close as cvd
        FROM "candles-1m"
        WHERE cvd_close IS NOT NULL
        ORDER BY ticker, time DESC
      `);

      for (const row of result.rows) {
        const cvd = parseFloat(row.cvd) || 0;
        this.cvdByTicker.set(row.ticker, cvd);
        console.log(`📈 Loaded CVD for ${row.ticker}: ${cvd.toLocaleString()}`);
      }

      this.initialized = true;
      console.log(`✅ TBBO Aggregator initialized with CVD for ${result.rows.length} ticker(s)`);
    } catch (err) {
      console.warn("⚠️ Could not load CVD from database, starting fresh:", err);
      this.initialized = true;
    }
  }

  /**
   * Get aggregator statistics for monitoring/health checks
   */
  getStats(): AggregatorStats {
    return {
      recordsProcessed: this.recordsProcessed,
      pendingCandles: this.candles.size,
      candlesWritten: this.candlesWritten,
      lateTradesRejected: this.stats.lateTradesRejected,
      unknownSideTrades: this.stats.unknownSideTrades,
      cvdByTicker: Object.fromEntries(this.cvdByTicker),
    };
  }

  // =========================================================================
  // Trade Processing
  // =========================================================================

  /**
   * Add a TBBO record to the aggregator
   * @returns true if accepted, false if rejected (e.g., too old)
   */
  addRecord(record: TbboRecord): boolean {
    // Reject late trades to prevent CVD corruption
    if (this.isLateTrade(record)) {
      return false;
    }

    const ticker = extractTicker(record.symbol);
    const minuteBucket = getMinuteBucket(record.timestamp);
    const key = `${ticker}|${minuteBucket}`;

    // Determine trade side using Lee-Ready algorithm as fallback
    const { isAsk, isBid } = determineTradeSide(
      record.side,
      record.price,
      record.bidPrice,
      record.askPrice
    );

    // Track unknown side trades (not inferred successfully)
    if (!isAsk && !isBid) {
      this.stats.unknownSideTrades++;
      if (this.stats.unknownSideTrades <= 5 || this.stats.unknownSideTrades % 1000 === 0) {
        console.log(
          `📊 Unknown side trade #${this.stats.unknownSideTrades}: ` +
            `${record.symbol} @ ${record.price} (bid: ${record.bidPrice}, ask: ${record.askPrice})`
        );
      }
    }

    // Create normalized trade for candle aggregation
    const normalizedTrade: NormalizedTrade = {
      ticker,
      minuteBucket,
      price: record.price,
      size: record.size,
      isAsk,
      isBid,
      symbol: record.symbol,
      bidPrice: record.bidPrice,
      askPrice: record.askPrice,
      bidSize: record.bidSize,
      askSize: record.askSize,
    };

    // Get context for metric calculation
    const baseCvd = this.cvdByTicker.get(ticker) || 0;
    const currentVd = this.getCurrentVdForTicker(key);
    const { vdStrength } = this.momentumTracker.getVdMomentum(ticker, currentVd);

    const context: MetricCalculationContext = {
      baseCvd,
      vdStrength,
    };

    // Add trade and update metrics OHLC
    addTradeAndUpdateMetrics(this.candles, key, normalizedTrade, context);

    this.recordsProcessed++;
    this.maybeLogStatus();

    return true;
  }

  /**
   * Get current VD for a ticker's candle (for momentum calculation)
   */
  private getCurrentVdForTicker(key: string): number {
    const candle = this.candles.get(key);
    if (!candle) return 0;
    return calculateVd(candle.askVolume, candle.bidVolume);
  }

  // =========================================================================
  // Flush Methods (Database Writes)
  // =========================================================================

  /**
   * Flush completed candles to database and save in-progress candles.
   * Called every 1 second.
   *
   * - Completed candles (past minutes): Written and removed from memory
   * - In-progress candles (current minute): Written but kept for continued aggregation
   */
  async flushCompleted(): Promise<void> {
    const { completed, inProgress } = this.partitionCandles();

    // Write and finalize completed candles
    if (completed.length > 0) {
      const success = await this.writeCandlesToDb(completed);
      if (success) {
        this.finalizeCompletedCandles(completed);
        console.log(`✅ Flushed ${completed.length} completed candle(s)`);
      } else {
        console.warn(`⚠️ Keeping ${completed.length} candle(s) in memory - will retry next flush`);
      }
    }

    // Save in-progress candles (keep in memory)
    if (inProgress.length > 0) {
      await this.writeCandlesToDb(inProgress);
      console.log(`🔄 Saved ${inProgress.length} in-progress candle(s)`);
    }
  }

  /**
   * Flush ALL candles to database (used during shutdown)
   */
  async flushAll(): Promise<void> {
    if (this.candles.size === 0) return;

    const toFlush = this.getAllCandles();
    const success = await this.writeCandlesToDb(toFlush);

    if (success) {
      this.finalizeCompletedCandles(toFlush);
      this.candles.clear();
      console.log(`🔄 Flushed all ${toFlush.length} pending candles`);
    } else {
      console.error(`❌ Failed to flush ${toFlush.length} candles on shutdown - data may be lost`);
    }
  }

  // =========================================================================
  // Private: Trade Processing Helpers
  // =========================================================================

  /**
   * Check if a trade is too old to process
   */
  private isLateTrade(record: TbboRecord): boolean {
    const tradeTimeMs = nsToMs(record.timestamp);
    const ageMs = Date.now() - tradeTimeMs;

    if (ageMs > MAX_TRADE_AGE_MS) {
      this.stats.lateTradesRejected++;
      if (this.stats.lateTradesRejected <= 5 || this.stats.lateTradesRejected % 100 === 0) {
        console.warn(
          `⚠️ Rejected late trade #${this.stats.lateTradesRejected}: ` +
            `${record.symbol} ${(ageMs / 1000).toFixed(1)}s old (max: ${MAX_TRADE_AGE_MS / 1000}s)`
        );
      }
      return true;
    }
    return false;
  }

  /**
   * Log status periodically (every 30 seconds)
   */
  private maybeLogStatus(): void {
    if (Date.now() - this.lastLogTime > 30000) {
      const unknownPct =
        this.recordsProcessed > 0
          ? ((this.stats.unknownSideTrades / this.recordsProcessed) * 100).toFixed(1)
          : "0";

      console.log(
        `📊 Aggregator: ${this.recordsProcessed.toLocaleString()} trades → ` +
          `${this.candles.size} pending candles, ` +
          `${this.candlesWritten.toLocaleString()} written | ` +
          `Unknown side: ${unknownPct}%, Late rejected: ${this.stats.lateTradesRejected}`
      );
      this.lastLogTime = Date.now();
    }
  }

  // =========================================================================
  // Private: Flush Helpers
  // =========================================================================

  /**
   * Partition candles into completed (past minutes) and in-progress (current minute)
   */
  private partitionCandles(): { completed: CandleForDb[]; inProgress: CandleForDb[] } {
    const now = new Date();
    now.setSeconds(0, 0);
    const currentMinute = now.toISOString();

    const completed: CandleForDb[] = [];
    const inProgress: CandleForDb[] = [];

    for (const [key, candle] of this.candles) {
      const [ticker, time] = key.split("|");
      const item = { key, ticker, time, candle };

      if (time < currentMinute) {
        completed.push(item);
      } else {
        inProgress.push(item);
      }
    }

    return { completed, inProgress };
  }

  /**
   * Get all candles as CandleForDb array
   */
  private getAllCandles(): CandleForDb[] {
    const result: CandleForDb[] = [];
    for (const [key, candle] of this.candles) {
      const [ticker, time] = key.split("|");
      result.push({ key, ticker, time, candle });
    }
    return result;
  }

  /**
   * Finalize completed candles: update CVD totals, VD history, and remove from memory
   */
  private finalizeCompletedCandles(candles: CandleForDb[]): void {
    for (const { key, ticker, candle } of candles) {
      const vd = calculateVd(candle.askVolume, candle.bidVolume);

      // Update CVD
      const currentCvd = this.cvdByTicker.get(ticker) || 0;
      this.cvdByTicker.set(ticker, currentCvd + vd);

      // Update VD history for momentum calculations
      this.momentumTracker.updateVdHistory(ticker, vd);

      this.candles.delete(key);
    }
  }

  // =========================================================================
  // Private: Database Operations
  // =========================================================================

  /**
   * Write candles to database using batch upsert with OHLC for all metrics
   * @returns true if successful, false if failed
   */
  private async writeCandlesToDb(candles: CandleForDb[]): Promise<boolean> {
    if (candles.length === 0) return true;

    try {
      // Sort by ticker, then time for correct CVD calculation in batches
      const sorted = [...candles].sort((a, b) => {
        if (a.ticker !== b.ticker) return a.ticker.localeCompare(b.ticker);
        return a.time.localeCompare(b.time);
      });

      const { values, placeholders } = this.buildInsertParams(sorted);

      // Build column list for OHLC metrics
      const query = `
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

      await pool.query(query, values);
      this.candlesWritten += candles.length;
      return true;
    } catch (err) {
      console.error("❌ Failed to write candles:", err);
      return false;
    }
  }

  /**
   * Build parameterized INSERT values with OHLC for all metrics
   */
  private buildInsertParams(candles: CandleForDb[]): {
    values: (string | number | null)[];
    placeholders: string[];
  } {
    const values: (string | number | null)[] = [];
    const placeholders: string[] = [];

    // 54 columns total:
    // 8 base (time, ticker, symbol, open, high, low, close, volume)
    // 40 OHLC metrics (10 metrics * 4 OHLC values each)
    // 6 non-OHLC (trades, max_trade_size, big_trades, big_volume, divergence, vd_strength)
    const COLUMNS_PER_ROW = 54;

    candles.forEach(({ ticker, time, candle }, i) => {
      // Get metrics OHLC from candle (calculated during trade processing)
      const m = candle.metricsOHLC;

      // If no metrics OHLC yet (shouldn't happen), calculate final values
      if (!m) {
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
          vdStrength: candle.vdStrength ?? 1,
        });

        const baseCvd = this.cvdByTicker.get(ticker) || 0;
        const cvd = baseCvd + finalMetrics.vd;

        // Use final values for all OHLC
        const offset = i * COLUMNS_PER_ROW;
        placeholders.push(this.buildPlaceholder(offset, COLUMNS_PER_ROW));
        values.push(
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
          finalMetrics.vdStrength
        );
        return;
      }

      // Calculate divergence from final values
      const divergence = calculateDivergence(m.pricePct.close, m.vdRatio.close);

      const offset = i * COLUMNS_PER_ROW;
      placeholders.push(this.buildPlaceholder(offset, COLUMNS_PER_ROW));
      values.push(
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
        candle.vdStrength ?? 1
      );
    });

    return { values, placeholders };
  }

  /**
   * Build placeholder string for parameterized query
   */
  private buildPlaceholder(offset: number, count: number): string {
    const parts: string[] = [];
    for (let i = 1; i <= count; i++) {
      parts.push(`$${offset + i}`);
    }
    return `(${parts.join(", ")})`;
  }
}
