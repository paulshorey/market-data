#!/usr/bin/env npx tsx
/**
 * Historical TBBO Data Processor (1-Minute Rolling Candles at 1-Second Resolution)
 *
 * Processes historical TBBO trade data from JSONL files and writes
 * rolling 1-minute candles to the database, one row per second.
 *
 * Each output row represents the trailing 60-second window of trade data.
 * This gives 1-minute candles at 1-second resolution — 60 rows per minute
 * instead of the traditional 1 row per minute.
 *
 * Algorithm:
 *   1. Trades are aggregated into 1-second buckets (same logic as tbbo-1s.ts)
 *   2. Each completed 1-second bucket is stored as a SecondSummary
 *   3. A sliding window of the last 60 SecondSummaries is maintained per ticker
 *   4. Each second, the window is aggregated into a single 1-minute candle
 *   5. The 1-minute candle is written to the database
 *
 * Warmup: No output is written until the sliding window spans a full
 * 60 seconds. This means the first ~59 seconds produce no database rows.
 *
 * Usage:
 *   npx tsx scripts/ingest/tbbo-1m-1s.ts <file1.json> [file2.json] ...
 *   npx tsx scripts/ingest/tbbo-1m-1s.ts ./data/*.json
 *
 * Requires table "candles_1m" with same schema as candles_1s.
 * NOTE: If the TimescaleDB continuous aggregate "candles_1m" exists,
 * it must be dropped first and replaced with a regular table.
 */

import "dotenv/config";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { pool } from "../../src/lib/db.js";

// Types
import type { CandleState, CandleForDb, NormalizedTrade, MetricCalculationContext, CvdContext } from "../../src/lib/trade/index.js";

// Trade processing utilities
import {
  extractTicker,
  determineTradeSide,
  createCandleFromTrade,
  updateCandleWithTrade,
  updateCandleCvdOHLC,
  buildCandleInsertQuery,
  buildCandleInsertParams,
  FrontMonthTracker,
} from "../../src/lib/trade/index.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Raw JSON structure from historical TBBO files
 * Supports both ISO timestamps and nanosecond epochs
 */
interface HistoricalTbboLevel {
  bid_px?: string | number;
  ask_px?: string | number;
  bid_sz?: number;
  ask_sz?: number;
  bid_ct?: number;
  ask_ct?: number;
}

interface HistoricalTbboJson {
  // Timestamps can be ISO string or nanosecond epoch (string or number)
  ts_recv?: string | number;
  timestamp?: string | number;
  hd?: {
    ts_event?: string | number;
    rtype?: number;
    publisher_id?: number;
    instrument_id?: number;
  };
  action?: string;
  side?: string;
  depth?: number;
  price: string | number;
  size: number;
  flags?: number;
  ts_in_delta?: number;
  sequence?: number;
  symbol: string;
  bid_px?: string | number;
  ask_px?: string | number;
  bidPrice?: number;
  askPrice?: number;
  bid_sz?: number;
  ask_sz?: number;
  levels?: HistoricalTbboLevel[];
}

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
// Timestamp Utilities
// ============================================================================

/**
 * Parse any timestamp format to 1-second bucket (truncate milliseconds)
 */
function toSecondBucket(timestamp: string | number): string {
  let date: Date;

  if (typeof timestamp === "number") {
    date = new Date(Math.floor(timestamp / 1_000_000));
  } else if (typeof timestamp === "string" && (timestamp.includes("T") || timestamp.includes("-"))) {
    date = new Date(timestamp);
  } else {
    date = new Date(Math.floor(parseInt(String(timestamp), 10) / 1_000_000));
  }

  date.setMilliseconds(0);
  return date.toISOString();
}

/**
 * Get the minute bucket from a second-resolution ISO timestamp.
 * Used by FrontMonthTracker which operates at minute granularity.
 */
function toMinuteBucketFromSecond(secondBucket: string): string {
  const date = new Date(secondBucket);
  date.setSeconds(0, 0);
  return date.toISOString();
}

// ============================================================================
// Configuration
// ============================================================================

/** Target database table for 1-minute rolling candles */
const TARGET_TABLE = "candles_1m";

/** Number of candles to batch before writing to database */
const BATCH_SIZE = 1000;

/** Flush pending candles when this many accumulate */
const FLUSH_THRESHOLD = 10000;

/** Progress logging interval (lines processed) */
const LOG_INTERVAL = 100000;

/** Number of seconds in the rolling window */
const WINDOW_SECONDS = 60;

/** Minimum time span (ms) for the window to be considered full.
 *  59 seconds = 60 distinct second-buckets spanning a full minute. */
const WINDOW_SPAN_MS = (WINDOW_SECONDS - 1) * 1000;

// ============================================================================
// State
// ============================================================================

/** Per-ticker rolling window state */
const tickerStates: Map<string, TickerRollingState> = new Map();

/** Batch of 1-minute candles queued for database write */
const pendingCandles: CandleForDb[] = [];

/** Front-month contract tracker (5-minute rolling volume window) */
const tracker = new FrontMonthTracker();

/** Statistics */
const stats = {
  filesProcessed: 0,
  linesProcessed: 0,
  tradesProcessed: 0,
  secondsProcessed: 0,
  candlesWritten: 0,
  candlesSkippedWarmup: 0,
  skippedNonTrade: 0,
  skippedSpreads: 0,
  unknownSide: 0,
};

// ============================================================================
// Initialization
// ============================================================================

/**
 * Load last CVD values from database for continuity.
 * Tries the target table first, falls back to candles_1s.
 */
async function loadCvdFromDatabase(): Promise<void> {
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
      const state = getOrCreateTickerState(row.ticker);
      state.runningCvd = cvd;
      state.secondStartCvd = cvd;
      console.log(`📈 Loaded CVD for ${row.ticker}: ${cvd.toLocaleString()}`);
    }

    console.log(`✅ Loaded CVD for ${result.rows.length} ticker(s) from database\n`);
  } catch (err) {
    console.warn("⚠️ Could not load CVD from database, starting fresh:", err);
  }
}

// ============================================================================
// Per-Ticker State Management
// ============================================================================

function getOrCreateTickerState(ticker: string): TickerRollingState {
  let state = tickerStates.get(ticker);
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
    tickerStates.set(ticker, state);
  }
  return state;
}

// ============================================================================
// Parsing (identical to tbbo-1s.ts)
// ============================================================================

/**
 * Parse a historical TBBO JSON line into a normalized trade.
 * Returns null if the line cannot be parsed or is not a trade.
 */
function parseHistoricalTbbo(line: string): NormalizedTrade | null {
  try {
    const json: HistoricalTbboJson = JSON.parse(line);

    // Skip non-trade records
    if (json.action !== undefined && json.action !== "T") {
      stats.skippedNonTrade++;
      return null;
    }

    // Skip calendar spreads (only process outright contracts)
    if (json.symbol.includes("-")) {
      stats.skippedSpreads++;
      return null;
    }

    // Parse price
    const price = typeof json.price === "number" ? json.price : parseFloat(json.price);
    if (!price || isNaN(price)) return null;

    // Get timestamp
    const timestamp = json.hd?.ts_event ?? json.ts_recv ?? json.timestamp;
    if (!timestamp) return null;

    // Extract BBO from levels array or top-level fields
    const level = json.levels?.[0];
    const bidPxRaw = level?.bid_px ?? json.bid_px;
    const askPxRaw = level?.ask_px ?? json.ask_px;
    const bidPrice = json.bidPrice ?? (bidPxRaw ? (typeof bidPxRaw === "number" ? bidPxRaw : parseFloat(String(bidPxRaw))) : 0);
    const askPrice = json.askPrice ?? (askPxRaw ? (typeof askPxRaw === "number" ? askPxRaw : parseFloat(String(askPxRaw))) : 0);
    const bidSz = level?.bid_sz ?? json.bid_sz ?? 0;
    const askSz = level?.ask_sz ?? json.ask_sz ?? 0;

    const ticker = extractTicker(json.symbol);
    const secondBucket = toSecondBucket(timestamp);

    // Determine trade side using Lee-Ready algorithm as fallback
    const { isAsk, isBid } = determineTradeSide(json.side || "", price, bidPrice || 0, askPrice || 0);
    if (!isAsk && !isBid) stats.unknownSide++;

    return {
      ticker,
      minuteBucket: secondBucket, // reusing field for second bucket ISO string
      price,
      size: json.size || 0,
      isAsk,
      isBid,
      symbol: json.symbol,
      bidPrice: bidPrice || 0,
      askPrice: askPrice || 0,
      bidSize: bidSz,
      askSize: askSz,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// Second Summary Creation
// ============================================================================

/**
 * Create a SecondSummary from a completed 1-second CandleState.
 * Captures all aggregated values and CVD OHLC for later window aggregation.
 */
function createSecondSummary(time: string, candle: CandleState): SecondSummary {
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

// ============================================================================
// Rolling Window Aggregation
// ============================================================================

/**
 * Aggregate an array of SecondSummaries into a single 1-minute CandleState.
 *
 * Combines all summaries in the sliding window:
 * - Price: open from first, close from last, high/low across all
 * - Volume/metrics: summed across all seconds
 * - CVD OHLC: open from first second, close from last, high/low across all
 * - Large trades: max trade size is max across all, counts/volume are summed
 */
function aggregateWindow(summaries: SecondSummary[]): CandleState {
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

// ============================================================================
// Second Boundary Processing
// ============================================================================

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
function onSecondComplete(ticker: string, state: TickerRollingState): void {
  if (!state.currentCandle || !state.currentSecondBucket) return;

  // 1. Create summary from the completed second
  const summary = createSecondSummary(state.currentSecondBucket, state.currentCandle);

  // Update running CVD to this second's closing value
  state.runningCvd = summary.cvdClose;

  // 2. Add to ring buffer
  state.ring.push(summary);
  stats.secondsProcessed++;
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
    stats.candlesSkippedWarmup++;
    state.currentCandle = null;
    state.currentSecondBucket = null;
    return;
  }

  // 5. Warmup gate: wait until we've collected WINDOW_SECONDS distinct seconds
  //    of data before producing any output. This is a one-time gate per startup
  //    (or after a >60s gap). Once warmup is done, every subsequent second writes.
  if (!state.warmupDone) {
    if (state.warmupSecondsCollected < WINDOW_SECONDS) {
      stats.candlesSkippedWarmup++;
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
  const candle = aggregateWindow(state.ring);
  const time = summary.time; // Use latest second as the candle timestamp
  const key = `${ticker}|${time}`;

  pendingCandles.push({ key, ticker, time, candle });

  // 7. Reset for next second
  state.currentCandle = null;
  state.currentSecondBucket = null;
}

// ============================================================================
// Trade Processing
// ============================================================================

/**
 * Process a single trade.
 *
 * 1. Check front-month contract eligibility
 * 2. Detect second boundary → finalize previous second if crossed
 * 3. Aggregate trade into the current second's CandleState
 * 4. Update CVD OHLC tracking for the current second
 */
function addTrade(trade: NormalizedTrade): void {
  const { ticker, symbol } = trade;
  const minuteBucket = toMinuteBucketFromSecond(trade.minuteBucket);
  const secondBucket = trade.minuteBucket;

  // Check with front-month tracker — returns false if not the active contract
  if (!tracker.addTrade(symbol, ticker, minuteBucket, trade.size)) {
    return;
  }

  const state = getOrCreateTickerState(ticker);

  // Detect second boundary crossing
  if (state.currentSecondBucket && secondBucket !== state.currentSecondBucket) {
    onSecondComplete(ticker, state);
  }

  // Initialize new second bucket if needed (first trade or after boundary)
  if (!state.currentSecondBucket) {
    state.currentSecondBucket = secondBucket;
    state.secondStartCvd = state.runningCvd;
  }

  // Add trade to current second's candle
  if (!state.currentCandle) {
    state.currentCandle = createCandleFromTrade(trade);
  } else {
    updateCandleWithTrade(state.currentCandle, trade);
  }

  // Update CVD OHLC tracking for this second
  const context: MetricCalculationContext = { baseCvd: state.secondStartCvd };
  updateCandleCvdOHLC(state.currentCandle, context);

  stats.tradesProcessed++;
}

// ============================================================================
// Database Operations
// ============================================================================

/**
 * Write a batch of candles to database.
 * CVD is already baked into each candle's metricsOHLC from aggregateWindow,
 * so the CvdContext is a no-op pass-through.
 */
async function writeBatch(batch: CandleForDb[]): Promise<void> {
  const cvdContext: CvdContext = {
    getBaseCvd: () => 0,
    updateCvd: () => {},
  };

  const { values, placeholders } = buildCandleInsertParams(batch, cvdContext);
  const query = buildCandleInsertQuery(TARGET_TABLE, placeholders);

  await pool.query(query, values);
  stats.candlesWritten += batch.length;
}

/**
 * Flush all pending candles to database in batches.
 */
async function flushPendingCandles(): Promise<void> {
  if (pendingCandles.length === 0) return;

  // Sort by ticker then time for orderly writes
  pendingCandles.sort((a, b) => {
    if (a.ticker !== b.ticker) return a.ticker.localeCompare(b.ticker);
    return a.time.localeCompare(b.time);
  });

  for (let i = 0; i < pendingCandles.length; i += BATCH_SIZE) {
    const batch = pendingCandles.slice(i, i + BATCH_SIZE);
    await writeBatch(batch);
  }

  console.log(`💾 Flushed ${pendingCandles.length} 1-minute candles to ${TARGET_TABLE}`);
  pendingCandles.length = 0;
}

// ============================================================================
// File Processing
// ============================================================================

/**
 * Finalize all in-progress seconds across all tickers.
 * Called at end of file to ensure the last second is not lost.
 */
function finalizeAllTickers(): void {
  for (const [ticker, state] of tickerStates) {
    if (state.currentCandle && state.currentSecondBucket) {
      onSecondComplete(ticker, state);
    }
  }
}

/**
 * Process a single JSONL file
 */
async function processFile(filePath: string): Promise<void> {
  console.log(`\n📂 Processing: ${filePath}`);

  const fileStream = createReadStream(filePath);
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let lineCount = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;

    const trade = parseHistoricalTbbo(line);
    if (trade) {
      addTrade(trade);
    }

    lineCount++;
    stats.linesProcessed++;

    // Log progress
    if (stats.linesProcessed % LOG_INTERVAL === 0) {
      console.log(
        `   📊 ${stats.linesProcessed.toLocaleString()} lines, ` +
          `${stats.tradesProcessed.toLocaleString()} trades, ` +
          `${stats.secondsProcessed.toLocaleString()} seconds, ` +
          `${pendingCandles.length.toLocaleString()} pending candles`,
      );
    }

    // Periodic flush to manage memory
    if (pendingCandles.length >= FLUSH_THRESHOLD) {
      await flushPendingCandles();
    }
  }

  // Finalize any in-progress seconds and flush remaining candles
  finalizeAllTickers();
  await flushPendingCandles();

  stats.filesProcessed++;
  console.log(`   ✅ Completed: ${lineCount.toLocaleString()} lines`);
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const files = process.argv.slice(2);

  if (files.length === 0) {
    console.error("Usage: npx tsx scripts/ingest/tbbo-1m-1s.ts <file1.json> [file2.json] ...");
    console.error("       npx tsx scripts/ingest/tbbo-1m-1s.ts ./data/*.json");
    process.exit(1);
  }

  console.log("═".repeat(60));
  console.log("📊 Historical TBBO Processor (1-minute rolling candles @ 1s resolution)");
  console.log("═".repeat(60));
  console.log(`   Files to process: ${files.length}`);
  console.log(`   Target table:     ${TARGET_TABLE}`);
  console.log(`   Window size:      ${WINDOW_SECONDS} seconds`);
  console.log("");

  // Load existing CVD from database
  await loadCvdFromDatabase();

  // Process each file
  for (const file of files) {
    await processFile(file);
  }

  // Final summary
  console.log("\n" + "═".repeat(60));
  console.log("📊 Processing Complete");
  console.log("═".repeat(60));
  console.log(`   Files processed:       ${stats.filesProcessed}`);
  console.log(`   Lines processed:       ${stats.linesProcessed.toLocaleString()}`);
  console.log(`   Trades processed:      ${stats.tradesProcessed.toLocaleString()}`);
  console.log(`   1-second buckets:      ${stats.secondsProcessed.toLocaleString()}`);
  console.log(`   1-minute candles:      ${stats.candlesWritten.toLocaleString()}`);
  console.log(`   Skipped (warmup):      ${stats.candlesSkippedWarmup.toLocaleString()}`);
  console.log(`   Skipped (non-front):   ${tracker.getSkippedCount().toLocaleString()}`);
  console.log(`   Skipped (spreads):     ${stats.skippedSpreads.toLocaleString()}`);
  console.log(`   Skipped (non-trade):   ${stats.skippedNonTrade.toLocaleString()}`);
  console.log(`   Unknown side:          ${stats.unknownSide.toLocaleString()}`);
  console.log("");
  console.log("   Active contract per ticker:");
  for (const [ticker, symbol] of tracker.getActiveContracts()) {
    const vol = tracker.getTotalVolumeBySymbol().get(symbol) || 0;
    console.log(`     ${ticker} → ${symbol} (vol ${vol.toLocaleString()})`);
  }
  console.log("");
  console.log("   Volume by contract:");
  const sortedSymbols = [...tracker.getTotalVolumeBySymbol().entries()].sort((a, b) => b[1] - a[1]);
  for (const [symbol, vol] of sortedSymbols) {
    const ticker = extractTicker(symbol);
    console.log(`     ${symbol} (${ticker}): ${vol.toLocaleString()}`);
  }
  console.log("");
  console.log("   Ring buffer state per ticker:");
  for (const [ticker, state] of tickerStates) {
    console.log(`     ${ticker}: ${state.ring.length} seconds in buffer, CVD ${state.runningCvd.toLocaleString()}`);
  }
  console.log("═".repeat(60));

  await pool.end();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
