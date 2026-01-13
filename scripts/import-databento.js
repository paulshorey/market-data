/**
 * DataBento OHLCV Import Script - Continuous Contract Builder
 *
 * Imports historical 1-minute candle data and builds a continuous futures series
 * by keeping only the highest-volume contract for each timestamp.
 *
 * Uses streaming to handle files of any size without memory limits.
 *
 * Usage:
 *   node --max-old-space-size=8192 scripts/import-databento.js <ticker> <file>
 *
 * Arguments:
 *   ticker - The ticker symbol to use (e.g., "ES", "NQ", "CL")
 *   file   - Absolute path to the data file (must start with /)
 *
 * Example:
 *   node --max-old-space-size=8192 scripts/import-databento.js ES /Users/you/data/ES-full-history.txt
 *
 * PREREQUISITE: Create the table first:
 *
 *   CREATE TABLE "candles-1m" (
 *       time TIMESTAMPTZ NOT NULL,
 *       ticker TEXT NOT NULL,
 *       symbol TEXT NOT NULL,
 *       open DOUBLE PRECISION NOT NULL,
 *       high DOUBLE PRECISION NOT NULL,
 *       low DOUBLE PRECISION NOT NULL,
 *       close DOUBLE PRECISION NOT NULL,
 *       volume DOUBLE PRECISION NOT NULL,
 *       PRIMARY KEY (ticker, time)
 *   );
 *
 *   -- For TimescaleDB (optional but recommended):
 *   SELECT create_hypertable('candles-1m', by_range('time', INTERVAL '1 month'));
 */

const fs = require("fs");
const readline = require("readline");
const { Pool } = require("pg");

// Load environment variables from .env file
require("dotenv").config();

// Configuration
const BATCH_SIZE = 1000; // Number of rows per INSERT batch
const MAX_RETRIES = 3; // Retry failed batches
const RETRY_DELAY_MS = 1000; // Wait between retries
const MAX_PARSE_ERRORS = 10; // Stop if more than this many parse errors

// Get CLI arguments
const TICKER = process.argv[2] || null;
const DATA_FILE = process.argv[3] || null;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

/**
 * Parse a single NDJSON line into a candle record
 * Skips spread contracts (symbols containing "-")
 * Uses CLI-provided TICKER for ticker column, file's symbol for symbol column
 */
function parseCandle(line) {
  const data = JSON.parse(line);

  // Skip spread contracts (e.g., "ESM0-ESU0")
  if (data.symbol.includes("-")) {
    return null;
  }

  return {
    time: data.hd.ts_event,
    ticker: TICKER, // CLI argument (e.g., "ES")
    symbol: data.symbol, // File's symbol (e.g., "ESM0", "ESU0")
    open: parseFloat(data.open),
    high: parseFloat(data.high),
    low: parseFloat(data.low),
    close: parseFloat(data.close),
    volume: parseFloat(data.volume),
  };
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deduplicate candles within a batch, keeping only highest volume per (ticker, time)
 */
function deduplicateBatch(candles) {
  const byTime = new Map();

  for (const candle of candles) {
    const key = `${candle.ticker}|${candle.time}`;
    const existing = byTime.get(key);

    if (!existing || candle.volume > existing.volume) {
      byTime.set(key, candle);
    }
  }

  return Array.from(byTime.values());
}

/**
 * Insert a batch of candles using UPSERT with volume comparison
 * Only updates if new volume > existing volume
 */
async function insertBatch(candles, batchNumber = 0) {
  if (candles.length === 0) return { inserted: 0, retries: 0 };

  // Deduplicate within batch first (keep highest volume per timestamp)
  const dedupedCandles = deduplicateBatch(candles);

  // Build parameterized query for batch insert (8 columns now)
  const values = [];
  const placeholders = [];

  dedupedCandles.forEach((candle, i) => {
    const offset = i * 8;
    placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8})`);
    values.push(candle.time, candle.ticker, candle.symbol, candle.open, candle.high, candle.low, candle.close, candle.volume);
  });

  // ON CONFLICT (ticker, time) - only compares within same ticker
  // WHERE clause ensures we only update if new volume > existing volume
  const query = `
    INSERT INTO "candles-1m" (time, ticker, symbol, open, high, low, close, volume)
    VALUES ${placeholders.join(", ")}
    ON CONFLICT (ticker, time) DO UPDATE SET
      symbol = EXCLUDED.symbol,
      open = EXCLUDED.open,
      high = EXCLUDED.high,
      low = EXCLUDED.low,
      close = EXCLUDED.close,
      volume = EXCLUDED.volume
    WHERE EXCLUDED.volume > "candles-1m".volume
  `;

  // Retry logic for transient failures
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await pool.query(query, values);
      return { inserted: dedupedCandles.length, retries: attempt - 1 };
    } catch (error) {
      lastError = error;

      // Don't retry on constraint/syntax errors - only transient connection issues
      const isTransient =
        error.code === "ECONNRESET" ||
        error.code === "ETIMEDOUT" ||
        error.code === "57P01" || // admin_shutdown
        error.code === "57P02" || // crash_shutdown
        error.code === "57P03" || // cannot_connect_now
        error.code === "08000" || // connection_exception
        error.code === "08003" || // connection_does_not_exist
        error.code === "08006"; // connection_failure

      if (!isTransient || attempt === MAX_RETRIES) {
        throw error;
      }

      console.warn(`\n⚠️  Batch ${batchNumber} failed (attempt ${attempt}/${MAX_RETRIES}): ${error.message}`);
      console.warn(`   Retrying in ${RETRY_DELAY_MS * attempt}ms...`);
      await sleep(RETRY_DELAY_MS * attempt); // Exponential backoff
    }
  }

  throw lastError;
}

/**
 * Format number with commas for display
 */
function formatNumber(num) {
  return num.toLocaleString();
}

/**
 * Format bytes in human readable form
 */
function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  } else if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  } else if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`;
  }
  return `${bytes} bytes`;
}

/**
 * Format duration in human readable form
 */
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * Main import function
 */
async function main() {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║     DataBento Continuous Contract Builder                  ║");
  console.log("║     (Keeps highest-volume contract per timestamp)          ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log();

  // Check if ticker argument was provided
  if (!TICKER) {
    console.error("❌ Error: Ticker symbol is required");
    console.error("");
    console.error("Usage:");
    console.error("  node --max-old-space-size=8192 scripts/import-databento.js <ticker> <file>");
    console.error("");
    console.error("Example:");
    console.error("  node --max-old-space-size=8192 scripts/import-databento.js ES /Users/you/data/ES-full-history.txt");
    process.exit(1);
  }

  // Check if file argument was provided and is absolute path
  if (!DATA_FILE || !DATA_FILE.startsWith("/")) {
    console.error("❌ Error: An absolute file path is required");
    console.error("");
    console.error("Usage:");
    console.error("  node --max-old-space-size=8192 scripts/import-databento.js <ticker> <file>");
    console.error("");
    console.error("Example:");
    console.error("  node --max-old-space-size=8192 scripts/import-databento.js ES /Users/you/data/ES-full-history.txt");
    process.exit(1);
  }

  // Check if file exists
  if (!fs.existsSync(DATA_FILE)) {
    console.error(`❌ Error: Data file not found: ${DATA_FILE}`);
    process.exit(1);
  }

  const fileStat = fs.statSync(DATA_FILE);
  const fileSize = fileStat.size;
  console.log(`🏷️  Ticker: ${TICKER}`);
  console.log(`📁 Input file: ${DATA_FILE}`);
  console.log(`📊 File size: ${formatBytes(fileSize)}`);
  console.log(`📊 Max parse errors allowed: ${MAX_PARSE_ERRORS}`);
  console.log(`📊 Spread contracts (with "-") will be skipped`);
  console.log();

  // Test database connection
  console.log("🔌 Testing database connection...");
  try {
    await pool.query("SELECT 1");
    console.log("✅ Database connected successfully");
  } catch (error) {
    console.error(`❌ Database connection failed: ${error.message}`);
    process.exit(1);
  }

  // Check if table exists
  try {
    await pool.query('SELECT 1 FROM "candles-1m" LIMIT 1');
    console.log('✅ Table "candles-1m" exists');
  } catch (error) {
    console.error('❌ Table "candles-1m" does not exist!');
    console.error("");
    console.error("Create it first with:");
    console.error("");
    console.error('  CREATE TABLE "candles-1m" (');
    console.error("      time TIMESTAMPTZ NOT NULL,");
    console.error("      ticker TEXT NOT NULL,");
    console.error("      symbol TEXT NOT NULL,");
    console.error("      open DOUBLE PRECISION NOT NULL,");
    console.error("      high DOUBLE PRECISION NOT NULL,");
    console.error("      low DOUBLE PRECISION NOT NULL,");
    console.error("      close DOUBLE PRECISION NOT NULL,");
    console.error("      volume DOUBLE PRECISION NOT NULL,");
    console.error("      PRIMARY KEY (ticker, time)");
    console.error("  );");
    console.error("");
    console.error("  -- For TimescaleDB:");
    console.error("  SELECT create_hypertable('candles-1m', by_range('time', INTERVAL '1 month'));");
    process.exit(1);
  }
  console.log();

  // Process file using streaming (handles files of any size)
  console.log(`🚀 Starting import (batch size: ${formatNumber(BATCH_SIZE)})...`);
  console.log("─".repeat(60));

  const startImport = Date.now();
  let linesRead = 0;
  let bytesRead = 0;
  let processed = 0;
  let skippedSpreads = 0;
  let parseErrors = 0;
  let totalRetries = 0;
  let batchNumber = 0;
  let batch = [];

  // Create read stream and readline interface
  const fileStream = fs.createReadStream(DATA_FILE);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity, // Handle both \n and \r\n
  });

  // Process each line
  for await (const line of rl) {
    linesRead++;
    // Track bytes read for progress (line length + newline character)
    bytesRead += Buffer.byteLength(line, "utf8") + 1;

    // Skip empty lines
    if (!line.trim()) continue;

    // Parse the line (skip on parse error)
    let candle;
    try {
      candle = parseCandle(line);
    } catch (parseError) {
      parseErrors++;
      console.error(`\n⚠️  Parse error on line ${linesRead}: ${parseError.message}`);
      console.error(`   Line content: ${line.substring(0, 100)}${line.length > 100 ? "..." : ""}`);

      // Check if too many parse errors
      if (parseErrors > MAX_PARSE_ERRORS) {
        console.error("\n");
        console.error("═".repeat(60));
        console.error("🛑 FATAL: TOO MANY PARSE ERRORS");
        console.error("═".repeat(60));
        console.error(`   Parse errors: ${parseErrors} (max allowed: ${MAX_PARSE_ERRORS})`);
        console.error(`   This suggests a problem with the file format.`);
        console.error(`   Records processed before failure: ${formatNumber(processed)}`);
        console.error(`   Failed at line: ${formatNumber(linesRead)}`);
        console.error("═".repeat(60));
        console.error("\n💡 Check your data file format matches the expected NDJSON structure.\n");
        rl.close();
        fileStream.destroy();
        await pool.end();
        process.exit(1);
      }

      continue; // Skip this line, continue with next
    }

    // Skip spread contracts (parseCandle returns null for spreads)
    if (candle === null) {
      skippedSpreads++;
      continue;
    }

    batch.push(candle);

    // When batch is full, insert it
    if (batch.length >= BATCH_SIZE) {
      batchNumber++;
      try {
        const result = await insertBatch(batch, batchNumber);
        processed += result.inserted;
        totalRetries += result.retries;
        batch = [];
      } catch (batchError) {
        // Batch insert failed after all retries - STOP IMMEDIATELY
        console.error("\n");
        console.error("═".repeat(60));
        console.error("🛑 FATAL: BATCH INSERT FAILED AFTER ALL RETRIES");
        console.error("═".repeat(60));
        console.error(`   Batch #${batchNumber} failed permanently`);
        console.error(`   Error: ${batchError.message}`);
        console.error(`   Error code: ${batchError.code || "N/A"}`);
        console.error(`   Records processed before failure: ${formatNumber(processed)}`);
        console.error(`   Failed at line: ~${formatNumber(linesRead)}`);
        console.error("═".repeat(60));
        console.error("\n💡 To resume: Fix the issue and re-run the script.");
        console.error("   The script uses volume-based UPSERT, so it's safe to re-run.\n");
        rl.close();
        fileStream.destroy();
        await pool.end();
        process.exit(1);
      }

      // Progress update (based on bytes read)
      const progress = fileSize > 0 ? ((bytesRead / fileSize) * 100).toFixed(1) : "0.0";
      const elapsed = Date.now() - startImport;
      const elapsedSec = elapsed / 1000 || 1; // Avoid division by zero
      const rate = Math.round(processed / elapsedSec);
      const bytesPerSec = bytesRead / elapsedSec;
      const remainingBytes = Math.max(0, fileSize - bytesRead);
      const etaSeconds = bytesPerSec > 0 ? remainingBytes / bytesPerSec : 0;

      process.stdout.write(
        `\r📊 Progress: ${progress}% | ` +
          `Processed: ${formatNumber(processed)} | ` +
          `Spreads skipped: ${formatNumber(skippedSpreads)} | ` +
          `ETA: ${formatDuration(etaSeconds * 1000)}   `
      );
    }
  }

  // Insert remaining batch
  if (batch.length > 0) {
    batchNumber++;
    try {
      const result = await insertBatch(batch, batchNumber);
      processed += result.inserted;
      totalRetries += result.retries;
    } catch (batchError) {
      console.error("\n");
      console.error("═".repeat(60));
      console.error("🛑 FATAL: FINAL BATCH INSERT FAILED AFTER ALL RETRIES");
      console.error("═".repeat(60));
      console.error(`   Batch #${batchNumber} (final) failed permanently`);
      console.error(`   Error: ${batchError.message}`);
      console.error(`   Error code: ${batchError.code || "N/A"}`);
      console.error(`   Records processed before failure: ${formatNumber(processed)}`);
      console.error("═".repeat(60));
      console.error("\n💡 To resume: Fix the issue and re-run the script.\n");
      await pool.end();
      process.exit(1);
    }
  }

  const totalTime = Date.now() - startImport;
  console.log("\n");
  console.log("─".repeat(60));

  // Check if anything was processed
  if (processed === 0) {
    console.log("⚠️  Import completed but NO RECORDS were processed!");
    console.log();
    console.log("📊 Summary:");
    console.log(`   • Lines read: ${formatNumber(linesRead)}`);
    console.log(`   • Spreads skipped: ${formatNumber(skippedSpreads)}`);
    console.log(`   • Parse errors: ${formatNumber(parseErrors)}`);
    console.log();
    console.log("💡 Check that your file contains valid NDJSON data.");
    await pool.end();
    process.exit(1);
  }

  console.log("✅ Import complete!");
  console.log();
  console.log("📊 Summary:");
  console.log(`   • Lines read: ${formatNumber(linesRead)}`);
  console.log(`   • Records processed: ${formatNumber(processed)}`);
  console.log(`   • Spread contracts skipped: ${formatNumber(skippedSpreads)}`);
  console.log(`   • Batches processed: ${formatNumber(batchNumber)}`);
  console.log(`   • Retries needed: ${formatNumber(totalRetries)}`);
  console.log(`   • Parse errors (skipped): ${formatNumber(parseErrors)}`);
  console.log(`   • Total time: ${formatDuration(totalTime)}`);
  console.log(`   • Average rate: ${formatNumber(Math.round(processed / (totalTime / 1000)))}/sec`);
  console.log();
  console.log("💡 Note: Actual rows in table may be fewer than records processed,");
  console.log("   because only the highest-volume contract is kept per timestamp.");

  // Cleanup
  await pool.end();
  console.log();
  console.log("👋 Done!");
}

// Run the import
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
