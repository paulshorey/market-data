/**
 * TBBO Aggregator
 *
 * Aggregates real-time TBBO (trade) data into 1-minute OHLCV candles
 * and writes them to the database every 1 second.
 *
 * Features:
 * - Volume Delta (VD): per-candle (askVolume - bidVolume)
 * - Cumulative Volume Delta (CVD): running total of VD across candles
 * - Order Flow Metrics:
 *   - VD Ratio: Normalized delta (-1 to +1) for cross-instrument comparison
 *   - Price Pct: Normalized price change in basis points
 *   - Divergence: Flag for accumulation/distribution detection
 *   - EVR: Effort vs Result absorption score
 * - Lee-Ready algorithm fallback for unknown trade sides
 * - Late trade rejection to prevent data corruption
 * - Graceful handling of DB write failures
 */

import { pool } from "../lib/db.js";
import type { TbboRecord, CandleState, CandleForDb, AggregatorStats } from "./types.js";
import {
  MAX_TRADE_AGE_MS,
  nsToMs,
  getMinuteBucket,
  extractTicker,
  inferSideFromPrice,
  calculateVd,
  calculateOrderFlowMetrics,
  getLargeTradeThreshold,
} from "./utils.js";

// Re-export TbboRecord for consumers that import from this file
export type { TbboRecord } from "./types.js";

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
        SELECT DISTINCT ON (ticker) ticker, cvd
        FROM "candles-1m"
        WHERE cvd IS NOT NULL
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
    const { isAsk, isBid } = this.determineSide(record);

    this.updateCandle(key, ticker, record, isAsk, isBid);
    this.recordsProcessed++;
    this.maybeLogStatus();

    return true;
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
   * Determine trade side, using Lee-Ready algorithm as fallback
   */
  private determineSide(record: TbboRecord): { isAsk: boolean; isBid: boolean } {
    let isAsk = record.side === "A";
    let isBid = record.side === "B";

    // If side unknown, try Lee-Ready algorithm
    if (!isAsk && !isBid) {
      const inferred = inferSideFromPrice(record.price, record.bidPrice, record.askPrice);
      if (inferred) {
        isAsk = inferred === "A";
        isBid = inferred === "B";
      } else {
        this.stats.unknownSideTrades++;
        if (this.stats.unknownSideTrades <= 5 || this.stats.unknownSideTrades % 1000 === 0) {
          console.log(
            `📊 Unknown side trade #${this.stats.unknownSideTrades}: ` +
              `${record.symbol} @ ${record.price} (bid: ${record.bidPrice}, ask: ${record.askPrice})`
          );
        }
      }
    }

    return { isAsk, isBid };
  }

  /**
   * Update or create a candle with trade data
   */
  private updateCandle(key: string, ticker: string, record: TbboRecord, isAsk: boolean, isBid: boolean): void {
    const existing = this.candles.get(key);

    // Calculate spread and midpoint for this trade
    const spread = record.askPrice > 0 && record.bidPrice > 0 
      ? record.askPrice - record.bidPrice 
      : 0;
    const midPrice = record.askPrice > 0 && record.bidPrice > 0 
      ? (record.askPrice + record.bidPrice) / 2 
      : record.price;

    // Check if this is a large trade
    const largeTradeThreshold = getLargeTradeThreshold(ticker);
    const isLargeTrade = record.size >= largeTradeThreshold;

    if (existing) {
      // OHLCV
      existing.high = Math.max(existing.high, record.price);
      existing.low = Math.min(existing.low, record.price);
      existing.close = record.price;
      existing.volume += record.size;
      existing.symbol = record.symbol;
      existing.tradeCount++;

      // Aggressive order flow
      if (isAsk) existing.askVolume += record.size;
      else if (isBid) existing.bidVolume += record.size;
      else existing.unknownSideVolume += record.size;

      // Passive order flow (book depth)
      existing.sumBidDepth += record.bidSize || 0;
      existing.sumAskDepth += record.askSize || 0;

      // Spread tracking
      existing.sumSpread += spread;
      existing.sumMidPrice += midPrice;

      // VWAP tracking
      existing.sumPriceVolume += record.price * record.size;

      // Large trade detection
      existing.maxTradeSize = Math.max(existing.maxTradeSize, record.size);
      if (isLargeTrade) {
        existing.largeTradeCount++;
        existing.largeTradeVolume += record.size;
      }
    } else {
      this.candles.set(key, {
        // OHLCV
        open: record.price,
        high: record.price,
        low: record.price,
        close: record.price,
        volume: record.size,

        // Aggressive order flow
        askVolume: isAsk ? record.size : 0,
        bidVolume: isBid ? record.size : 0,
        unknownSideVolume: !isAsk && !isBid ? record.size : 0,

        // Passive order flow (book depth)
        sumBidDepth: record.bidSize || 0,
        sumAskDepth: record.askSize || 0,

        // Spread tracking
        sumSpread: spread,
        sumMidPrice: midPrice,

        // VWAP tracking
        sumPriceVolume: record.price * record.size,

        // Large trade detection
        maxTradeSize: record.size,
        largeTradeCount: isLargeTrade ? 1 : 0,
        largeTradeVolume: isLargeTrade ? record.size : 0,

        symbol: record.symbol,
        tradeCount: 1,
      });
    }
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
   * Finalize completed candles: update CVD totals and remove from memory
   */
  private finalizeCompletedCandles(candles: CandleForDb[]): void {
    for (const { key, ticker, candle } of candles) {
      const vd = calculateVd(candle.askVolume, candle.bidVolume);
      const currentCvd = this.cvdByTicker.get(ticker) || 0;
      this.cvdByTicker.set(ticker, currentCvd + vd);
      this.candles.delete(key);
    }
  }

  // =========================================================================
  // Private: Database Operations
  // =========================================================================

  /**
   * Write candles to database using batch upsert
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

      const query = `
        INSERT INTO "candles-1m" (
          time, ticker, symbol, open, high, low, close, volume,
          vd, cvd, vd_ratio, book_imbalance,
          price_pct, vwap, spread_bps,
          trades, avg_trade_size,
          max_trade_size, big_trades, big_volume,
          divergence, evr, smp
        )
        VALUES ${placeholders.join(", ")}
        ON CONFLICT (ticker, time) DO UPDATE SET
          symbol = EXCLUDED.symbol,
          open = "candles-1m".open,
          high = GREATEST("candles-1m".high, EXCLUDED.high),
          low = LEAST("candles-1m".low, EXCLUDED.low),
          close = EXCLUDED.close,
          volume = EXCLUDED.volume,
          vd = EXCLUDED.vd,
          cvd = EXCLUDED.cvd,
          vd_ratio = EXCLUDED.vd_ratio,
          book_imbalance = EXCLUDED.book_imbalance,
          price_pct = EXCLUDED.price_pct,
          vwap = EXCLUDED.vwap,
          spread_bps = EXCLUDED.spread_bps,
          trades = EXCLUDED.trades,
          avg_trade_size = EXCLUDED.avg_trade_size,
          max_trade_size = GREATEST("candles-1m".max_trade_size, EXCLUDED.max_trade_size),
          big_trades = EXCLUDED.big_trades,
          big_volume = EXCLUDED.big_volume,
          divergence = EXCLUDED.divergence,
          evr = EXCLUDED.evr,
          smp = EXCLUDED.smp
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
   * Build parameterized INSERT values with all order flow metrics
   */
  private buildInsertParams(candles: CandleForDb[]): {
    values: (string | number | null)[];
    placeholders: string[];
  } {
    const values: (string | number | null)[] = [];
    const placeholders: string[] = [];

    // Track running CVD per ticker within this batch
    const batchCvd: Map<string, number> = new Map();

    candles.forEach(({ ticker, time, candle }, i) => {
      // Calculate all order flow metrics
      const metrics = calculateOrderFlowMetrics({
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
      });

      // Use batch running total if available, otherwise use stored CVD
      const baseCvd = batchCvd.get(ticker) ?? (this.cvdByTicker.get(ticker) || 0);
      const cvd = baseCvd + metrics.vd;
      batchCvd.set(ticker, cvd);

      // 23 columns total
      const offset = i * 23;
      placeholders.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, ` +
          `$${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, ` +
          `$${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, $${offset + 15}, ` +
          `$${offset + 16}, $${offset + 17}, $${offset + 18}, $${offset + 19}, $${offset + 20}, ` +
          `$${offset + 21}, $${offset + 22}, $${offset + 23})`
      );
      values.push(
        time,
        ticker,
        candle.symbol,
        candle.open,
        candle.high,
        candle.low,
        candle.close,
        candle.volume,
        metrics.vd,
        cvd,
        metrics.vdRatio,
        metrics.bookImbalance,
        metrics.pricePct,
        metrics.vwap,
        metrics.spreadBps,
        metrics.trades,
        metrics.avgTradeSize,
        metrics.maxTradeSize,
        metrics.bigTrades,
        metrics.bigVolume,
        metrics.divergence,
        metrics.evr,
        metrics.smp
      );
    });

    return { values, placeholders };
  }
}
