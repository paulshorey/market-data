/**
 * TBBO Rolling 1-Minute Aggregator
 *
 * Aggregates real-time TBBO (trade) data into rolling 1-minute candles
 * at 1-second resolution and writes them to the candles_1m table.
 *
 * Each output row represents the trailing 60-second window of trade data.
 * This gives 1-minute candles at 1-second resolution — up to 60 rows per
 * minute instead of the traditional 1 row per minute.
 *
 * Algorithm (same as scripts/ingest/tbbo-1m-1s.ts, class-based for live use):
 *   1. Trades are aggregated into 1-second buckets per ticker
 *   2. Each completed 1-second bucket is stored as a SecondSummary
 *   3. A sliding window of the last 60 SecondSummaries is maintained per ticker
 *   4. Each second, the window is aggregated into a single 1-minute candle
 *   5. The 1-minute candle is written to candles_1m
 *
 * Warmup: No output is written for a ticker until its sliding window spans
 * a full 60 seconds. This means the first ~59 seconds after startup produce
 * no database rows for that ticker.
 *
 * Differences from the historical batch script:
 * - Class-based (instantiated by tbbo-stream.ts)
 * - Accepts TbboRecord objects directly (already parsed by the stream)
 * - Timer-based flush catches stale seconds (no new trades arriving)
 * - Late trade rejection (prevents CVD corruption from delayed data)
 * - Market hours gating is handled by the stream, not the aggregator
 */

import { pool } from "../lib/db.js";

// Types
import type {
  TbboRecord,
  CandleState,
  CandleForDb,
  AggregatorStats,
  NormalizedTrade,
  MetricCalculationContext,
  CvdContext,
} from "../lib/trade/index.js";

// Trade processing utilities
import {
  MAX_TRADE_AGE_MS,
  nsToMs,
  getSecondBucket,
  getMinuteBucket,
  extractTicker,
  determineTradeSide,
  createCandleFromTrade,
  updateCandleWithTrade,
  updateCandleCvdOHLC,
  buildCandleInsertQuery,
  buildCandleInsertParams,
  FrontMonthTracker,
} from "../lib/trade/index.js";

// Re-export TbboRecord for consumers that import from this file
export type { TbboRecord } from "../lib/trade/index.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Summary of a completed 1-second bucket.
 * Stores all aggregated values needed to combine multiple seconds
 * into a rolling 1-minute candle.
 */
interface SecondSummary {
  /** ISO timestamp of this second bucket */
  time: string;
  /** Epoch milliseconds for fast time arithmetic */
  timeMs: number;

  // Price OHLC
  open: number;
  high: number;
  low: number;
  close: number;

  // Volume
  volume: number;
  askVolume: number;
  bidVolume: number;
  unknownSideVolume: number;

  // Book depth (for book imbalance calculation)
  sumBidDepth: number;
  sumAskDepth: number;

  // Spread tracking
  sumSpread: number;
  sumMidPrice: number;

  // VWAP
  sumPriceVolume: number;

  // Large trades
  maxTradeSize: number;
  largeTradeCount: number;
  largeTradeVolume: number;

  // Activity
  tradeCount: number;
  symbol: string;

  // CVD OHLC (absolute running values tracked during this second)
  cvdOpen: number;
  cvdHigh: number;
  cvdLow: number;
  cvdClose: number;

  // Volume delta for this second
  vd: number;
}

/**
 * Per-ticker state for the rolling 1-minute window aggregation
 */
interface TickerRollingState {
  /** Ring buffer of completed 1-second summaries, ordered by time */
  ring: SecondSummary[];

  /** CandleState for the current (in-progress) second */
  currentCandle: CandleState | null;

  /** ISO timestamp of the current second being accumulated */
  currentSecondBucket: string | null;

  /** Running CVD total for this ticker (updated when seconds complete) */
  runningCvd: number;

  /** CVD value at the start of the current second (base for CVD calculation) */
  secondStartCvd: number;

  /** Whether warmup is complete (collected enough seconds to start writing) */
  warmupDone: boolean;

  /** Number of distinct seconds collected in the current warmup cycle */
  warmupSecondsCollected: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Target database table */
const TARGET_TABLE = "candles_1m";

/** Max candles per INSERT query (prevents oversized queries on batch accumulation) */
const WRITE_BATCH_SIZE = 500;

/** Max pending candles before oldest are dropped (prevents unbounded memory growth) */
const MAX_PENDING_CANDLES = 5000;

/** Number of seconds in the rolling window */
const WINDOW_SECONDS = 60;

/** Minimum time span (ms) for the window to be considered full.
 *  59 seconds = 60 distinct second-buckets spanning a full minute. */
const WINDOW_SPAN_MS = (WINDOW_SECONDS - 1) * 1000;

// ============================================================================
// Main Aggregator Class
// ============================================================================

/**
 * Aggregates TBBO records into rolling 1-minute candles at 1-second resolution.
 * Writes to the candles_1m table.
 */
export class Tbbo1mAggregator {
  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /** Per-ticker rolling window state */
  private tickerStates: Map<string, TickerRollingState> = new Map();

  /** Batch of 1-minute candles queued for database write */
  private pendingCandles: CandleForDb[] = [];

  /** Front-month contract tracker (5-minute rolling volume window) */
  private tracker = new FrontMonthTracker();

  /** Whether initialize() has been called */
  private initialized = false;

  // -------------------------------------------------------------------------
  // Statistics
  // -------------------------------------------------------------------------

  private recordsProcessed = 0;
  private candlesWritten = 0;
  private secondsProcessed = 0;
  private candlesSkippedWarmup = 0;
  private lastLogTime = Date.now();

  private stats = {
    lateTradesRejected: 0,
    unknownSideTrades: 0,
  };

  // =========================================================================
  // Lifecycle Methods
  // =========================================================================

  constructor() {
    console.log("📊 TBBO 1m Aggregator created (call initialize() to load CVD from database)");
  }

  /**
   * Initialize the aggregator by loading last CVD values from database.
   * Tries candles_1m first, falls back to candles_1s for continuity.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      console.warn("⚠️ Aggregator already initialized");
      return;
    }

    try {
      let result;
      try {
        result = await pool.query(`
          SELECT DISTINCT ON (ticker) ticker, cvd_close as cvd
          FROM ${TARGET_TABLE}
          WHERE cvd_close IS NOT NULL
          ORDER BY ticker, time DESC
        `);
      } catch {
        result = await pool.query(`
          SELECT DISTINCT ON (ticker) ticker, cvd_close as cvd
          FROM candles_1s
          WHERE cvd_close IS NOT NULL
          ORDER BY ticker, time DESC
        `);
      }

      for (const row of result.rows) {
        const cvd = parseFloat(row.cvd) || 0;
        const state = this.getOrCreateTickerState(row.ticker);
        state.runningCvd = cvd;
        state.secondStartCvd = cvd;
        console.log(`📈 Loaded CVD for ${row.ticker}: ${cvd.toLocaleString()}`);
      }

      this.initialized = true;
      console.log(`✅ TBBO 1m Aggregator initialized with CVD for ${result.rows.length} ticker(s)`);
    } catch (err) {
      console.warn("⚠️ Could not load CVD from database, starting fresh:", err);
      this.initialized = true;
    }
  }

  /**
   * Get aggregator statistics for monitoring/health checks
   */
  getStats(): AggregatorStats {
    const cvdByTicker: Record<string, number> = {};
    for (const [ticker, state] of this.tickerStates) {
      cvdByTicker[ticker] = state.runningCvd;
    }

    return {
      recordsProcessed: this.recordsProcessed,
      pendingCandles: this.pendingCandles.length,
      candlesWritten: this.candlesWritten,
      lateTradesRejected: this.stats.lateTradesRejected,
      unknownSideTrades: this.stats.unknownSideTrades,
      skippedNonFront: this.tracker.getSkippedCount(),
      activeContracts: Object.fromEntries(this.tracker.getActiveContracts()),
      cvdByTicker,
    };
  }

  // =========================================================================
  // Trade Processing
  // =========================================================================

  /**
   * Add a TBBO record to the aggregator.
   *
   * 1. Reject late trades
   * 2. Check front-month contract eligibility
   * 3. Detect second boundary -> finalize previous second if crossed
   * 4. Aggregate trade into the current second's CandleState
   * 5. Update CVD OHLC tracking
   *
   * @returns true if accepted, false if rejected
   */
  addRecord(record: TbboRecord): boolean {
    // Reject late trades to prevent CVD corruption
    if (this.isLateTrade(record)) {
      return false;
    }

    const ticker = extractTicker(record.symbol);
    const secondBucket = getSecondBucket(record.timestamp);
    const minuteBucket = getMinuteBucket(record.timestamp);

    // Check with front-month tracker
    if (!this.tracker.addTrade(record.symbol, ticker, minuteBucket, record.size)) {
      return false;
    }

    const state = this.getOrCreateTickerState(ticker);

    // Detect second boundary crossing
    if (state.currentSecondBucket && secondBucket !== state.currentSecondBucket) {
      this.onSecondComplete(ticker, state);
    }

    // Initialize new second bucket if needed (first trade or after boundary)
    if (!state.currentSecondBucket) {
      state.currentSecondBucket = secondBucket;
      state.secondStartCvd = state.runningCvd;
    }

    // Determine trade side using Lee-Ready algorithm as fallback
    const { isAsk, isBid } = determineTradeSide(
      record.side,
      record.price,
      record.bidPrice,
      record.askPrice,
    );

    if (!isAsk && !isBid) {
      this.stats.unknownSideTrades++;
      if (this.stats.unknownSideTrades <= 5 || this.stats.unknownSideTrades % 1000 === 0) {
        console.log(
          `📊 Unknown side trade #${this.stats.unknownSideTrades}: ` +
            `${record.symbol} @ ${record.price} (bid: ${record.bidPrice}, ask: ${record.askPrice})`,
        );
      }
    }

    // Create normalized trade for candle aggregation
    const trade: NormalizedTrade = {
      ticker,
      minuteBucket: secondBucket,
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

    // Add trade to current second's candle
    if (!state.currentCandle) {
      state.currentCandle = createCandleFromTrade(trade);
    } else {
      updateCandleWithTrade(state.currentCandle, trade);
    }

    // Update CVD OHLC tracking for this second
    const context: MetricCalculationContext = { baseCvd: state.secondStartCvd };
    updateCandleCvdOHLC(state.currentCandle, context);

    this.recordsProcessed++;
    this.maybeLogStatus();

    return true;
  }

  // =========================================================================
  // Flush Methods (Database Writes)
  // =========================================================================

  /**
   * Flush completed candles to database.
   * Called every 1 second by the stream timer.
   *
   * 1. For each ticker, finalize any "stale" current second (its bucket is
   *    before the current wall-clock second, meaning no new trades arrived
   *    to trigger the boundary naturally).
   * 2. Write all pending 1-minute rolling candles to the database.
   */
  async flushCompleted(): Promise<void> {
    // Finalize stale seconds across all tickers
    this.finalizeStaleSeconds();

    // Cap pending queue to prevent unbounded growth during prolonged DB outages
    if (this.pendingCandles.length > MAX_PENDING_CANDLES) {
      const dropped = this.pendingCandles.length - MAX_PENDING_CANDLES;
      this.pendingCandles = this.pendingCandles.slice(dropped);
      console.warn(`⚠️ Dropped ${dropped} oldest pending candles (queue exceeded ${MAX_PENDING_CANDLES})`);
    }

    // Write pending candles in batches
    if (this.pendingCandles.length > 0) {
      let totalWritten = 0;
      let failed = false;

      while (this.pendingCandles.length > 0 && !failed) {
        const batch = this.pendingCandles.splice(0, WRITE_BATCH_SIZE);
        const success = await this.writeBatch(batch);
        if (success) {
          totalWritten += batch.length;
        } else {
          // Put the failed batch back at the front for retry next flush
          this.pendingCandles.unshift(...batch);
          failed = true;
        }
      }

      if (totalWritten > 0) {
        console.log(`✅ Flushed ${totalWritten} rolling 1m candle(s) to ${TARGET_TABLE}`);
      }
      if (failed) {
        console.warn(`⚠️ DB write failed, ${this.pendingCandles.length} candle(s) queued for retry`);
      }
    }
  }

  /**
   * Flush ALL pending data (used during shutdown).
   * Finalizes all in-progress seconds and writes everything.
   */
  async flushAll(): Promise<void> {
    // Finalize all in-progress seconds
    for (const [ticker, state] of this.tickerStates) {
      if (state.currentCandle && state.currentSecondBucket) {
        this.onSecondComplete(ticker, state);
      }
    }

    // Write all pending candles in batches
    const total = this.pendingCandles.length;
    if (total > 0) {
      let written = 0;
      while (this.pendingCandles.length > 0) {
        const batch = this.pendingCandles.splice(0, WRITE_BATCH_SIZE);
        const success = await this.writeBatch(batch);
        if (success) {
          written += batch.length;
        } else {
          console.error(
            `❌ Failed to flush ${batch.length + this.pendingCandles.length} candles on shutdown - data may be lost`,
          );
          return;
        }
      }
      console.log(`🔄 Flushed all ${written} pending rolling 1m candles`);
    }
  }

  // =========================================================================
  // Private: Per-Ticker State Management
  // =========================================================================

  private getOrCreateTickerState(ticker: string): TickerRollingState {
    let state = this.tickerStates.get(ticker);
    if (!state) {
      state = {
        ring: [],
        currentCandle: null,
        currentSecondBucket: null,
        runningCvd: 0,
        secondStartCvd: 0,
        warmupDone: false,
        warmupSecondsCollected: 0,
      };
      this.tickerStates.set(ticker, state);
    }
    return state;
  }

  // =========================================================================
  // Private: Second Summary Creation
  // =========================================================================

  /**
   * Create a SecondSummary from a completed 1-second CandleState.
   */
  private createSecondSummary(time: string, candle: CandleState): SecondSummary {
    const cvdOhlc = candle.metricsOHLC?.cvd;
    const vd = candle.askVolume - candle.bidVolume;

    return {
      time,
      timeMs: new Date(time).getTime(),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      askVolume: candle.askVolume,
      bidVolume: candle.bidVolume,
      unknownSideVolume: candle.unknownSideVolume,
      sumBidDepth: candle.sumBidDepth,
      sumAskDepth: candle.sumAskDepth,
      sumSpread: candle.sumSpread,
      sumMidPrice: candle.sumMidPrice,
      sumPriceVolume: candle.sumPriceVolume,
      maxTradeSize: candle.maxTradeSize,
      largeTradeCount: candle.largeTradeCount,
      largeTradeVolume: candle.largeTradeVolume,
      tradeCount: candle.tradeCount,
      symbol: candle.symbol,
      cvdOpen: cvdOhlc?.open ?? candle.currentCvd ?? 0,
      cvdHigh: cvdOhlc?.high ?? candle.currentCvd ?? 0,
      cvdLow: cvdOhlc?.low ?? candle.currentCvd ?? 0,
      cvdClose: candle.currentCvd ?? 0,
      vd,
    };
  }

  // =========================================================================
  // Private: Rolling Window Aggregation
  // =========================================================================

  /**
   * Aggregate an array of SecondSummaries into a single 1-minute CandleState.
   *
   * Combines all summaries in the sliding window:
   * - Price: open from first, close from last, high/low across all
   * - Volume/metrics: summed across all seconds
   * - CVD OHLC: open from first second, close from last, high/low across all
   * - Large trades: max trade size is max across all, counts/volume are summed
   */
  private aggregateWindow(summaries: SecondSummary[]): CandleState {
    const first = summaries[0];
    const last = summaries[summaries.length - 1];

    let high = first.high;
    let low = first.low;
    let volume = 0;
    let askVolume = 0;
    let bidVolume = 0;
    let unknownSideVolume = 0;
    let sumBidDepth = 0;
    let sumAskDepth = 0;
    let sumSpread = 0;
    let sumMidPrice = 0;
    let sumPriceVolume = 0;
    let maxTradeSize = 0;
    let largeTradeCount = 0;
    let largeTradeVolume = 0;
    let tradeCount = 0;
    let cvdHigh = first.cvdHigh;
    let cvdLow = first.cvdLow;

    for (const s of summaries) {
      high = Math.max(high, s.high);
      low = Math.min(low, s.low);
      volume += s.volume;
      askVolume += s.askVolume;
      bidVolume += s.bidVolume;
      unknownSideVolume += s.unknownSideVolume;
      sumBidDepth += s.sumBidDepth;
      sumAskDepth += s.sumAskDepth;
      sumSpread += s.sumSpread;
      sumMidPrice += s.sumMidPrice;
      sumPriceVolume += s.sumPriceVolume;
      maxTradeSize = Math.max(maxTradeSize, s.maxTradeSize);
      largeTradeCount += s.largeTradeCount;
      largeTradeVolume += s.largeTradeVolume;
      tradeCount += s.tradeCount;
      cvdHigh = Math.max(cvdHigh, s.cvdHigh);
      cvdLow = Math.min(cvdLow, s.cvdLow);
    }

    return {
      open: first.open,
      high,
      low,
      close: last.close,
      volume,
      askVolume,
      bidVolume,
      unknownSideVolume,
      sumBidDepth,
      sumAskDepth,
      sumSpread,
      sumMidPrice,
      sumPriceVolume,
      maxTradeSize,
      largeTradeCount,
      largeTradeVolume,
      tradeCount,
      symbol: last.symbol,
      currentCvd: last.cvdClose,
      metricsOHLC: {
        cvd: {
          open: first.cvdOpen,
          high: cvdHigh,
          low: cvdLow,
          close: last.cvdClose,
        },
      },
    };
  }

  // =========================================================================
  // Private: Second Boundary Processing
  // =========================================================================

  /**
   * Called when a second boundary is crossed for a ticker.
   *
   * Workflow:
   * 1. Finalize the current second's CandleState into a SecondSummary
   * 2. Push the summary into the ticker's ring buffer
   * 3. Prune summaries older than 60 seconds from the front
   * 4. If the window spans a full 60 seconds, aggregate and queue for DB write
   * 5. Reset the current-second state for the next second
   */
  private onSecondComplete(ticker: string, state: TickerRollingState): void {
    if (!state.currentCandle || !state.currentSecondBucket) return;

    // 1. Create summary from the completed second
    const summary = this.createSecondSummary(state.currentSecondBucket, state.currentCandle);

    // Update running CVD to this second's closing value
    state.runningCvd = summary.cvdClose;

    // 2. Add to ring buffer
    state.ring.push(summary);
    this.secondsProcessed++;
    state.warmupSecondsCollected++;

    // 3. Prune entries outside the 60-second window
    const latestMs = summary.timeMs;
    const cutoffMs = latestMs - WINDOW_SPAN_MS;
    let pruneIdx = 0;
    while (pruneIdx < state.ring.length && state.ring[pruneIdx].timeMs < cutoffMs) {
      pruneIdx++;
    }
    if (pruneIdx > 0) {
      state.ring = state.ring.slice(pruneIdx);
    }

    // 4. If ring is empty after pruning, there was a gap longer than 60 seconds.
    //    Re-enter warmup since we have no recent data to aggregate.
    if (state.ring.length === 0) {
      state.warmupDone = false;
      state.warmupSecondsCollected = 0;
      this.candlesSkippedWarmup++;
      state.currentCandle = null;
      state.currentSecondBucket = null;
      return;
    }

    // 5. Warmup gate: wait until we've collected WINDOW_SECONDS distinct seconds
    //    of data before producing any output.
    if (!state.warmupDone) {
      if (state.warmupSecondsCollected < WINDOW_SECONDS) {
        this.candlesSkippedWarmup++;
        state.currentCandle = null;
        state.currentSecondBucket = null;
        return;
      }
      state.warmupDone = true;
      console.log(
        `🔥 Warmup complete for ${ticker} at ${summary.time} ` +
          `(${state.ring.length} seconds in buffer)`,
      );
    }

    // 6. Aggregate the ring buffer into a 1-minute candle and queue for DB write
    const candle = this.aggregateWindow(state.ring);
    const time = summary.time; // Use latest second as the candle timestamp
    const key = `${ticker}|${time}`;

    this.pendingCandles.push({ key, ticker, time, candle });

    // 7. Reset for next second
    state.currentCandle = null;
    state.currentSecondBucket = null;
  }

  /**
   * Finalize "stale" seconds across all tickers.
   *
   * A second is stale if its bucket timestamp is before the current
   * wall-clock second. This catches the case where no new trade arrives
   * to naturally trigger onSecondComplete — e.g., brief gaps in trading.
   */
  private finalizeStaleSeconds(): void {
    const now = new Date();
    now.setMilliseconds(0);
    const currentSecond = now.toISOString();

    for (const [ticker, state] of this.tickerStates) {
      if (
        state.currentCandle &&
        state.currentSecondBucket &&
        state.currentSecondBucket < currentSecond
      ) {
        this.onSecondComplete(ticker, state);
      }
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
            `${record.symbol} ${(ageMs / 1000).toFixed(1)}s old (max: ${MAX_TRADE_AGE_MS / 1000}s)`,
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

      const warmupTickers: string[] = [];
      const activeTickers: string[] = [];
      for (const [ticker, state] of this.tickerStates) {
        if (state.warmupDone) {
          activeTickers.push(`${ticker}(${state.ring.length}s)`);
        } else {
          warmupTickers.push(`${ticker}(${state.warmupSecondsCollected}/${WINDOW_SECONDS})`);
        }
      }

      console.log(
        `📊 1m Aggregator: ${this.recordsProcessed.toLocaleString()} trades → ` +
          `${this.candlesWritten.toLocaleString()} candles written | ` +
          `Active: ${activeTickers.join(", ") || "none"} | ` +
          `Warmup: ${warmupTickers.join(", ") || "none"} | ` +
          `Unknown side: ${unknownPct}%, Late rejected: ${this.stats.lateTradesRejected}`,
      );
      this.lastLogTime = Date.now();
    }
  }

  // =========================================================================
  // Private: Database Operations
  // =========================================================================

  /**
   * Write a batch of 1-minute candles to database.
   * CVD is already baked into each candle's metricsOHLC from aggregateWindow,
   * so the CvdContext is a no-op pass-through.
   *
   * @returns true if successful, false if failed
   */
  private async writeBatch(batch: CandleForDb[]): Promise<boolean> {
    if (batch.length === 0) return true;

    try {
      // Sort by ticker then time for orderly writes
      const sorted = [...batch].sort((a, b) => {
        if (a.ticker !== b.ticker) return a.ticker.localeCompare(b.ticker);
        return a.time.localeCompare(b.time);
      });

      const cvdContext: CvdContext = {
        getBaseCvd: () => 0,
        updateCvd: () => {},
      };

      const { values, placeholders } = buildCandleInsertParams(sorted, cvdContext);
      const query = buildCandleInsertQuery(TARGET_TABLE, placeholders);

      await pool.query(query, values);
      this.candlesWritten += sorted.length;
      return true;
    } catch (err) {
      console.error("❌ Failed to write 1m candles:", err);
      return false;
    }
  }
}
