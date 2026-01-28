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
  CvdContext,
} from "../lib/trade/index.js";

// Import trade processing utilities
import {
  MAX_TRADE_AGE_MS,
  nsToMs,
  getMinuteBucket,
  extractTicker,
  determineTradeSide,
  addTradeAndUpdateMetrics,
  buildCandleInsertQuery,
  buildCandleInsertParams,
} from "../lib/trade/index.js";

// Import metrics calculations
import { calculateVd, MomentumTracker } from "../lib/metrics/index.js";

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

      // Create CVD context that uses our cvdByTicker map
      const cvdContext: CvdContext = {
        getBaseCvd: (ticker: string) => this.cvdByTicker.get(ticker) || 0,
        // Don't update CVD here - it's updated in finalizeCompletedCandles
      };

      const { values, placeholders } = buildCandleInsertParams(sorted, cvdContext);
      const query = buildCandleInsertQuery(placeholders);

      await pool.query(query, values);
      this.candlesWritten += candles.length;
      return true;
    } catch (err) {
      console.error("❌ Failed to write candles:", err);
      return false;
    }
  }
}
