#!/usr/bin/env npx tsx
/**
 * Historical TBBO Data Processor
 *
 * Processes historical TBBO trade data from JSONL files and writes
 * 1-minute OHLCV candles with VD and CVD to the database.
 *
 * Usage:
 *   npx tsx scripts/historical-tbbo.ts <file1.json> [file2.json] ...
 *   npx tsx scripts/historical-tbbo.ts ./data/*.json
 *
 * Features:
 * - Processes JSONL files (one JSON object per line)
 * - Calculates Volume Delta (VD) and Cumulative Volume Delta (CVD)
 * - Resumable: loads last CVD from database on startup
 * - Batch writes for performance
 */

import "dotenv/config";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { pool } from "../src/lib/db.js";
import { extractTicker, inferSideFromPrice, calculateVd, calculateMomentum } from "../src/stream/utils.js";
import type { CandleState, CandleForDb } from "../src/stream/types.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Raw JSON structure from historical TBBO files
 * Supports both ISO timestamps and nanosecond epochs
 */
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
  side?: string; // "A" or "B"
  depth?: number;
  price: string | number; // "6853.000000000" or 6853.0
  size: number;
  flags?: number;
  ts_in_delta?: number;
  sequence?: number;
  symbol: string; // "ESZ5"
  // Optional BBO fields (may not be present in trades-only files)
  bid_px?: string | number;
  ask_px?: string | number;
  bidPrice?: number; // Alternative field name
  askPrice?: number; // Alternative field name
  bid_sz?: number;
  ask_sz?: number;
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

/** Map of ticker|timestamp -> CandleState */
const candles: Map<string, CandleState> = new Map();

/** Cumulative Volume Delta per ticker */
const cvdByTicker: Map<string, number> = new Map();

/** Statistics */
const stats = {
  filesProcessed: 0,
  linesProcessed: 0,
  tradesProcessed: 0,
  candlesWritten: 0,
  skippedNonTrade: 0,
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
      SELECT DISTINCT ON (ticker) ticker, cvd
      FROM "candles-1m"
      WHERE cvd IS NOT NULL
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
 * Parse any timestamp format to minute bucket
 * Supports:
 * - ISO string: "2025-12-01T00:00:00.003176304Z"
 * - Nanosecond epoch string: "1768275460711927889"
 * - Nanosecond epoch number: 1768275460711927889
 */
function toMinuteBucket(timestamp: string | number): string {
  let date: Date;

  if (typeof timestamp === "number") {
    // Nanosecond epoch number - convert to milliseconds
    date = new Date(Math.floor(timestamp / 1_000_000));
  } else if (timestamp.includes("T") || timestamp.includes("-")) {
    // ISO string format
    date = new Date(timestamp);
  } else {
    // Nanosecond epoch string - convert to milliseconds
    date = new Date(Math.floor(parseInt(timestamp, 10) / 1_000_000));
  }

  date.setSeconds(0, 0);
  return date.toISOString();
}

/**
 * Parse a historical TBBO JSON line
 * Handles various field names and timestamp formats
 */
function parseHistoricalTbbo(line: string): {
  ticker: string;
  minuteBucket: string;
  price: number;
  size: number;
  side: string;
  symbol: string;
  bidPrice: number;
  askPrice: number;
} | null {
  try {
    const json: HistoricalTbboJson = JSON.parse(line);

    // Skip non-trade records (if action field exists)
    if (json.action !== undefined && json.action !== "T") {
      stats.skippedNonTrade++;
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

    // Parse bid/ask prices (can be string, number, or from alternative field names)
    const bidPrice = json.bidPrice ?? (json.bid_px ? (typeof json.bid_px === "number" ? json.bid_px : parseFloat(json.bid_px)) : 0);
    const askPrice = json.askPrice ?? (json.ask_px ? (typeof json.ask_px === "number" ? json.ask_px : parseFloat(json.ask_px)) : 0);

    return {
      ticker: extractTicker(json.symbol),
      minuteBucket: toMinuteBucket(timestamp),
      price,
      size: json.size || 0,
      side: json.side || "",
      symbol: json.symbol,
      bidPrice: bidPrice || 0,
      askPrice: askPrice || 0,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// Candle Aggregation
// ============================================================================

/**
 * Add a trade to the candle map
 */
function addTrade(trade: NonNullable<ReturnType<typeof parseHistoricalTbbo>>): void {
  const key = `${trade.ticker}|${trade.minuteBucket}`;

  // Determine side
  let isAsk = trade.side === "A";
  let isBid = trade.side === "B";

  // If side unknown, try Lee-Ready algorithm
  if (!isAsk && !isBid && trade.bidPrice && trade.askPrice) {
    const inferred = inferSideFromPrice(trade.price, trade.bidPrice, trade.askPrice);
    if (inferred) {
      isAsk = inferred === "A";
      isBid = inferred === "B";
    } else {
      stats.unknownSide++;
    }
  } else if (!isAsk && !isBid) {
    stats.unknownSide++;
  }

  const existing = candles.get(key);

  if (existing) {
    existing.high = Math.max(existing.high, trade.price);
    existing.low = Math.min(existing.low, trade.price);
    existing.close = trade.price;
    existing.volume += trade.size;
    existing.symbol = trade.symbol;
    existing.tradeCount++;

    if (isAsk) existing.askVolume += trade.size;
    else if (isBid) existing.bidVolume += trade.size;
    else existing.unknownSideVolume += trade.size;
  } else {
    candles.set(key, {
      open: trade.price,
      high: trade.price,
      low: trade.price,
      close: trade.price,
      volume: trade.size,
      askVolume: isAsk ? trade.size : 0,
      bidVolume: isBid ? trade.size : 0,
      unknownSideVolume: !isAsk && !isBid ? trade.size : 0,
      symbol: trade.symbol,
      tradeCount: 1,
    });
  }

  stats.tradesProcessed++;
}

// ============================================================================
// Database Operations
// ============================================================================

/**
 * Flush all candles to database
 */
async function flushCandles(): Promise<void> {
  if (candles.size === 0) return;

  // Convert to array and sort by ticker, then time
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
  // This map persists across batches within this flush operation
  const runningCvd: Map<string, number> = new Map();

  // Write in batches
  for (let i = 0; i < candleList.length; i += BATCH_SIZE) {
    const batch = candleList.slice(i, i + BATCH_SIZE);
    await writeBatch(batch, runningCvd);
  }

  // Update global CVD totals from the running CVD (which accumulated across all batches)
  for (const [ticker, cvd] of runningCvd) {
    cvdByTicker.set(ticker, cvd);
  }

  console.log(`💾 Flushed ${candles.size} candles to database`);
  candles.clear();
}

/**
 * Write a batch of candles to database
 * @param batch - Array of candles to write
 * @param runningCvd - Shared CVD accumulator across batches (mutated in place)
 */
async function writeBatch(batch: CandleForDb[], runningCvd: Map<string, number>): Promise<void> {
  const values: (string | number | null)[] = [];
  const placeholders: string[] = [];

  batch.forEach(({ ticker, time, candle }, i) => {
    const vd = calculateVd(candle.askVolume, candle.bidVolume);

    // Use running total if available (from previous batches), otherwise use stored CVD
    const baseCvd = runningCvd.get(ticker) ?? (cvdByTicker.get(ticker) || 0);
    const cvd = baseCvd + vd;
    runningCvd.set(ticker, cvd);

    // Calculate momentum: price efficiency relative to volume delta
    const momentum = calculateMomentum(candle.open, candle.close, vd);

    const offset = i * 11;
    placeholders.push(
      `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, ` +
        `$${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11})`
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
      vd,
      cvd,
      momentum
    );
  });

  const query = `
    INSERT INTO "candles-1m" (time, ticker, symbol, open, high, low, close, volume, vd, cvd, momentum)
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
      momentum = EXCLUDED.momentum
    WHERE EXCLUDED.volume >= "candles-1m".volume
  `;

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
          `${candles.size.toLocaleString()} pending candles`
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
    console.error("Usage: npx tsx scripts/historical-tbbo.ts <file1.json> [file2.json] ...");
    console.error("       npx tsx scripts/historical-tbbo.ts ./data/*.json");
    process.exit(1);
  }

  console.log("═".repeat(60));
  console.log("📊 Historical TBBO Processor");
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
  console.log(`   Skipped non-trade:  ${stats.skippedNonTrade.toLocaleString()}`);
  console.log(`   Unknown side:       ${stats.unknownSide.toLocaleString()}`);
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
