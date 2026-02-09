#!/usr/bin/env npx tsx
/**
 * Historical TBBO Data Processor (1-Second Resolution)
 *
 * Processes historical TBBO trade data from JSONL files and writes
 * 1-second OHLCV candles with VD and CVD to the database.
 *
 * Usage:
 *   npx tsx scripts/ingest/tbbo-1s.ts <file1.json> [file2.json] ...
 *   npx tsx scripts/ingest/tbbo-1s.ts ./data/*.json
 *
 * Features:
 * - Processes JSONL files (one JSON object per line)
 * - Aggregates trades into 1-second buckets (vs 1-minute in ingest-databento-tbbo-1m)
 * - Calculates Volume Delta (VD) and Cumulative Volume Delta (CVD)
 * - Calculates all order flow metrics with OHLC tracking
 * - Resumable: loads last CVD from database on startup
 * - Batch writes for performance
 *
 * Requires table "candles_1s" (see scripts/sql/setup-candles.sql).
 */

import "dotenv/config";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { pool } from "../../src/lib/db.js";

// Import types from trade library
import type { CandleState, CandleForDb, NormalizedTrade, MetricCalculationContext, CvdContext } from "../../src/lib/trade/index.js";

// Import trade processing utilities (excluding toMinuteBucket - we use toSecondBucket)
import {
  extractTicker,
  determineTradeSide,
  addTradeAndUpdateMetrics,
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
  ts_recv?: string | number; // "2025-12-01T00:00:00.003176304Z" or "1768275460711927889"
  timestamp?: string | number; // Alternative field name for timestamp
  hd?: {
    ts_event?: string | number; // ISO or nanosecond epoch
    rtype?: number;
    publisher_id?: number;
    instrument_id?: number;
  };
  action?: string; // "T" for trade
  side?: string; // "A" or "B" or "N" (neutral/unknown)
  depth?: number;
  price: string | number; // "6853.000000000" or 6853.0
  size: number;
  flags?: number;
  ts_in_delta?: number;
  sequence?: number;
  symbol: string; // "ESZ5"
  // BBO fields - can be at top level OR in levels array
  // Top level (flat format)
  bid_px?: string | number;
  ask_px?: string | number;
  bidPrice?: number; // Alternative field name
  askPrice?: number; // Alternative field name
  bid_sz?: number;
  ask_sz?: number;
  // Nested format (TBBO from Databento)
  levels?: HistoricalTbboLevel[];
}

// ============================================================================
// Second bucket utility
// ============================================================================

/**
 * Parse any timestamp format to 1-second bucket (truncate milliseconds)
 * Supports:
 * - ISO string: "2025-12-01T00:00:00.003176304Z"
 * - Nanosecond epoch string: "1768275460711927889"
 * - Nanosecond epoch number: 1768275460711927889
 *
 * @param timestamp - Timestamp in any supported format
 * @returns ISO string for the start of the second
 */
function toSecondBucket(timestamp: string | number): string {
  let date: Date;

  if (typeof timestamp === "number") {
    // Nanosecond epoch number - convert to milliseconds
    date = new Date(Math.floor(timestamp / 1_000_000));
  } else if (typeof timestamp === "string" && (timestamp.includes("T") || timestamp.includes("-"))) {
    // ISO string format
    date = new Date(timestamp);
  } else {
    // Nanosecond epoch string - convert to milliseconds
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

/** Number of candles to batch before writing to database */
const BATCH_SIZE = 1000;

/** Progress logging interval */
const LOG_INTERVAL = 100000;

// ============================================================================
// State
// ============================================================================

/** Map of ticker|timestamp -> CandleState (only the active/front-month contract) */
const candles: Map<string, CandleState> = new Map();

/** Cumulative Volume Delta per ticker */
const cvdByTicker: Map<string, number> = new Map();

/** Front-month contract tracker (5-minute rolling volume window) */
const tracker = new FrontMonthTracker();

/** Statistics */
const stats = {
  filesProcessed: 0,
  linesProcessed: 0,
  tradesProcessed: 0,
  candlesWritten: 0,
  skippedNonTrade: 0,
  skippedSpreads: 0,
  unknownSide: 0,
};

// ============================================================================
// Initialization
// ============================================================================

/**
 * Load last CVD values from database for continuity
 */
async function loadCvdFromDatabase(): Promise<void> {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (ticker) ticker, cvd_close as cvd
      FROM candles_1s
      WHERE cvd_close IS NOT NULL
      ORDER BY ticker, time DESC
    `);

    for (const row of result.rows) {
      const cvd = parseFloat(row.cvd) || 0;
      cvdByTicker.set(row.ticker, cvd);
      console.log(`📈 Loaded CVD for ${row.ticker}: ${cvd.toLocaleString()}`);
    }

    console.log(`✅ Loaded CVD for ${result.rows.length} ticker(s) from database\n`);
  } catch (err) {
    console.warn("⚠️ Could not load CVD from database, starting fresh:", err);
  }
}

// ============================================================================
// Parsing
// ============================================================================

/**
 * Parse a historical TBBO JSON line into a normalized trade
 * Returns null if the line cannot be parsed or is not a trade
 */
function parseHistoricalTbbo(line: string): NormalizedTrade | null {
  try {
    const json: HistoricalTbboJson = JSON.parse(line);

    // Skip non-trade records (if action field exists)
    if (json.action !== undefined && json.action !== "T") {
      stats.skippedNonTrade++;
      return null;
    }

    // Skip calendar spreads (e.g., "ESH5-ESM5") - only process outright contracts
    if (json.symbol.includes("-")) {
      stats.skippedSpreads++;
      return null;
    }

    // Parse price (can be string or number)
    const price = typeof json.price === "number" ? json.price : parseFloat(json.price);
    if (!price || isNaN(price)) {
      return null;
    }

    // Get timestamp - try multiple possible field locations
    const timestamp = json.hd?.ts_event ?? json.ts_recv ?? json.timestamp;
    if (!timestamp) {
      return null;
    }

    // Extract BBO from levels array if present (TBBO format from Databento)
    // Otherwise fall back to top-level fields
    const level = json.levels?.[0];

    // Parse bid/ask prices - check levels array first, then top-level fields
    const bidPxRaw = level?.bid_px ?? json.bid_px;
    const askPxRaw = level?.ask_px ?? json.ask_px;
    const bidPrice = json.bidPrice ?? (bidPxRaw ? (typeof bidPxRaw === "number" ? bidPxRaw : parseFloat(String(bidPxRaw))) : 0);
    const askPrice = json.askPrice ?? (askPxRaw ? (typeof askPxRaw === "number" ? askPxRaw : parseFloat(String(askPxRaw))) : 0);

    // Parse bid/ask sizes - check levels array first, then top-level fields
    const bidSz = level?.bid_sz ?? json.bid_sz ?? 0;
    const askSz = level?.ask_sz ?? json.ask_sz ?? 0;

    const ticker = extractTicker(json.symbol);
    const secondBucket = toSecondBucket(timestamp);

    // Determine trade side using Lee-Ready algorithm as fallback
    const { isAsk, isBid } = determineTradeSide(json.side || "", price, bidPrice || 0, askPrice || 0);

    // Track unknown side trades
    if (!isAsk && !isBid) {
      stats.unknownSide++;
    }

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
// Candle Aggregation
// ============================================================================

/**
 * Add a trade to the candle map.
 * Uses FrontMonthTracker (5-minute rolling volume window) to determine
 * which contract is the active front-month. Only trades from the active
 * contract are aggregated into the stitched ticker candle.
 */
function addTrade(trade: NormalizedTrade): void {
  const { ticker, symbol } = trade;
  const minuteBucket = toMinuteBucketFromSecond(trade.minuteBucket);

  // Check with tracker - returns false if this symbol is not the front-month
  if (!tracker.addTrade(symbol, ticker, minuteBucket, trade.size)) {
    return;
  }

  // Key by ticker|secondBucket for the stitched continuous series
  const key = `${ticker}|${trade.minuteBucket}`;

  const baseCvd = cvdByTicker.get(ticker) || 0;
  const context: MetricCalculationContext = {
    baseCvd,
  };

  addTradeAndUpdateMetrics(candles, key, trade, context);
  stats.tradesProcessed++;
}

// ============================================================================
// Database Operations
// ============================================================================

/**
 * Flush all candles to database.
 * Candles are already filtered to only the active contract per ticker,
 * so this is a straightforward write.
 */
async function flushCandles(): Promise<void> {
  if (candles.size === 0) return;

  // Convert to array and sort by ticker, then time for correct CVD accumulation
  const candleList: CandleForDb[] = [];
  for (const [key, candle] of candles) {
    const [ticker, time] = key.split("|");
    candleList.push({ key, ticker, time, candle });
  }

  candleList.sort((a, b) => {
    if (a.ticker !== b.ticker) return a.ticker.localeCompare(b.ticker);
    return a.time.localeCompare(b.time);
  });

  // Track running CVD across all batches to ensure correct accumulation
  const runningCvd: Map<string, number> = new Map();

  // Write in batches
  for (let i = 0; i < candleList.length; i += BATCH_SIZE) {
    const batch = candleList.slice(i, i + BATCH_SIZE);
    await writeBatch(batch, runningCvd);
  }

  // Update global CVD totals from the running CVD
  for (const [ticker, cvd] of runningCvd) {
    cvdByTicker.set(ticker, cvd);
  }

  console.log(`💾 Flushed ${candles.size} candles to database`);
  candles.clear();
}

/**
 * Write a batch of candles to database with OHLC for all metrics
 */
async function writeBatch(batch: CandleForDb[], runningCvd: Map<string, number>): Promise<void> {
  // Create CVD context that tracks running CVD across batches
  const cvdContext: CvdContext = {
    getBaseCvd: (ticker: string) => runningCvd.get(ticker) ?? (cvdByTicker.get(ticker) || 0),
    updateCvd: (ticker: string, newCvd: number) => runningCvd.set(ticker, newCvd),
  };

  const { values, placeholders } = buildCandleInsertParams(batch, cvdContext);
  const query = buildCandleInsertQuery("candles_1s", placeholders);

  await pool.query(query, values);
  stats.candlesWritten += batch.length;
}

// ============================================================================
// File Processing
// ============================================================================

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
          `${candles.size.toLocaleString()} pending candles`,
      );
    }
  }

  // Flush after each file to ensure data is saved
  await flushCandles();

  stats.filesProcessed++;
  console.log(`   ✅ Completed: ${lineCount.toLocaleString()} lines`);
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const files = process.argv.slice(2);

  if (files.length === 0) {
    console.error("Usage: npx tsx scripts/ingest-databento-tbbo-1s.ts <file1.json> [file2.json] ...");
    console.error("       npx tsx scripts/ingest-databento-tbbo-1s.ts ./data/*.json");
    process.exit(1);
  }

  console.log("═".repeat(60));
  console.log("📊 Historical TBBO Processor (1-second candles + OHLC metrics)");
  console.log("═".repeat(60));
  console.log(`   Files to process: ${files.length}`);
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
  console.log(`   Files processed:    ${stats.filesProcessed}`);
  console.log(`   Lines processed:    ${stats.linesProcessed.toLocaleString()}`);
  console.log(`   Trades processed:   ${stats.tradesProcessed.toLocaleString()}`);
  console.log(`   Candles written:    ${stats.candlesWritten.toLocaleString()}`);
  console.log(`   Skipped non-front:  ${tracker.getSkippedCount().toLocaleString()}`);
  console.log(`   Skipped spreads:    ${stats.skippedSpreads.toLocaleString()}`);
  console.log(`   Skipped non-trade:  ${stats.skippedNonTrade.toLocaleString()}`);
  console.log(`   Unknown side:       ${stats.unknownSide.toLocaleString()}`);
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
  console.log("   Final CVD values:");
  for (const [ticker, cvd] of cvdByTicker) {
    console.log(`     ${ticker}: ${cvd.toLocaleString()}`);
  }
  console.log("═".repeat(60));

  await pool.end();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
