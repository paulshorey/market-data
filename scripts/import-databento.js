/**
 * DataBento OHLCV Import Script
 *
 * Imports historical 1-minute candle data from DataBento export file into the database.
 *
 * Usage:
 *   node --max-old-space-size=8192 scripts/import-databento.js /absolute/path/to/file.txt
 *
 * The file path must be an absolute path (starting with /).
 */

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

// Load environment variables from .env file
require("dotenv").config();

// Configuration
const BATCH_SIZE = 1000; // Number of rows per INSERT batch (conservative for stability)
const MAX_RETRIES = 3; // Retry failed batches
const RETRY_DELAY_MS = 1000; // Wait between retries

// Get data file from CLI argument (must be absolute path)
const DATA_FILE = process.argv[2] || null;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

/**
 * Parse a single NDJSON line into a candle record
 */
function parseCandle(line) {
  const data = JSON.parse(line);

  return {
    time: data.hd.ts_event,
    ticker: data.symbol,
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
 * Insert a batch of candles using UPSERT (ON CONFLICT DO UPDATE)
 * Includes retry logic for transient failures
 */
async function insertBatch(candles, batchNumber = 0) {
  if (candles.length === 0) return { inserted: 0, retries: 0 };

  // Build parameterized query for batch insert
  const values = [];
  const placeholders = [];

  candles.forEach((candle, i) => {
    const offset = i * 7;
    placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`);
    values.push(candle.time, candle.ticker, candle.open, candle.high, candle.low, candle.close, candle.volume);
  });

  const query = `
    INSERT INTO "candles-1m" (time, ticker, open, high, low, close, volume)
    VALUES ${placeholders.join(", ")}
    ON CONFLICT (ticker, time) DO UPDATE SET
      open = EXCLUDED.open,
      high = EXCLUDED.high,
      low = EXCLUDED.low,
      close = EXCLUDED.close,
      volume = EXCLUDED.volume
  `;

  // Retry logic for transient failures
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await pool.query(query, values);
      return { inserted: candles.length, retries: attempt - 1 };
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
  console.log("║           DataBento OHLCV Import Script                    ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log();

  // Check if file argument was provided and is absolute path
  if (!DATA_FILE || !DATA_FILE.startsWith("/")) {
    console.error("❌ Error: An absolute file path is required");
    console.error("");
    console.error("Usage:");
    console.error("  node --max-old-space-size=8192 scripts/import-databento.js /absolute/path/to/file.txt");
    console.error("");
    console.error("Example:");
    console.error("  node --max-old-space-size=8192 scripts/import-databento.js /Users/you/data/ES-20251230-full-history-OHLCV.txt");
    process.exit(1);
  }

  // Check if file exists
  if (!fs.existsSync(DATA_FILE)) {
    console.error(`❌ Error: Data file not found: ${DATA_FILE}`);
    process.exit(1);
  }

  const fileStat = fs.statSync(DATA_FILE);
  console.log(`📁 Input file: ${DATA_FILE}`);
  console.log(`📊 File size: ${(fileStat.size / (1024 * 1024 * 1024)).toFixed(2)} GB`);
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
  console.log();

  // Read entire file into memory
  console.log("📖 Reading file into memory...");
  const startRead = Date.now();
  const fileContent = fs.readFileSync(DATA_FILE, "utf-8");
  const readTime = Date.now() - startRead;
  console.log(`✅ File read complete (${formatDuration(readTime)})`);
  console.log();

  // Split into lines and filter empty lines
  console.log("🔍 Parsing lines...");
  const lines = fileContent.split("\n").filter((line) => line.trim().length > 0);
  const totalLines = lines.length;
  const maxParseErrors = Math.min(Math.floor(totalLines * 0.01), 10); // 1% or max 10
  console.log(`📊 Total records to import: ${formatNumber(totalLines)}`);
  console.log(`📊 Max parse errors allowed: ${formatNumber(maxParseErrors)}`);
  console.log();

  // Process in batches
  console.log(`🚀 Starting import (batch size: ${formatNumber(BATCH_SIZE)})...`);
  console.log("─".repeat(60));

  const startImport = Date.now();
  let imported = 0;
  let parseErrors = 0;
  let totalRetries = 0;
  let batchNumber = 0;
  let batch = [];

  for (let i = 0; i < totalLines; i++) {
    // Parse the line (skip on parse error)
    let candle;
    try {
      candle = parseCandle(lines[i]);
    } catch (parseError) {
      parseErrors++;
      console.error(`\n⚠️  Parse error on line ${i + 1}: ${parseError.message}`);
      console.error(`   Line content: ${lines[i].substring(0, 100)}${lines[i].length > 100 ? "..." : ""}`);

      // Check if too many parse errors
      if (parseErrors > maxParseErrors) {
        console.error("\n");
        console.error("═".repeat(60));
        console.error("🛑 FATAL: TOO MANY PARSE ERRORS");
        console.error("═".repeat(60));
        console.error(`   Parse errors: ${parseErrors} (max allowed: ${maxParseErrors})`);
        console.error(`   This suggests a problem with the file format.`);
        console.error(`   Records imported before failure: ${formatNumber(imported)}`);
        console.error(`   Failed at line: ${formatNumber(i + 1)}`);
        console.error("═".repeat(60));
        console.error("\n💡 Check your data file format matches the expected NDJSON structure.\n");
        await pool.end();
        process.exit(1);
      }

      continue; // Skip this line, continue with next
    }

    batch.push(candle);

    // When batch is full, insert it
    if (batch.length >= BATCH_SIZE) {
      batchNumber++;
      try {
        const result = await insertBatch(batch, batchNumber);
        imported += result.inserted;
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
        console.error(`   Records imported before failure: ${formatNumber(imported)}`);
        console.error(`   Last successful line: ~${formatNumber(i - batch.length)}`);
        console.error("═".repeat(60));
        console.error("\n💡 To resume: Fix the issue and re-run the script.");
        console.error("   The script uses UPSERT, so already-imported rows will be updated.\n");
        await pool.end();
        process.exit(1);
      }

      // Progress update
      const progress = ((imported / totalLines) * 100).toFixed(1);
      const elapsed = Date.now() - startImport;
      const rate = Math.round(imported / (elapsed / 1000));
      const eta = Math.round((totalLines - imported) / rate);

      process.stdout.write(
        `\r📊 Progress: ${formatNumber(imported)}/${formatNumber(totalLines)} (${progress}%) | ` +
          `Rate: ${formatNumber(rate)}/sec | ETA: ${formatDuration(eta * 1000)}   `
      );
    }
  }

  // Insert remaining batch
  if (batch.length > 0) {
    batchNumber++;
    try {
      const result = await insertBatch(batch, batchNumber);
      imported += result.inserted;
      totalRetries += result.retries;
    } catch (batchError) {
      console.error("\n");
      console.error("═".repeat(60));
      console.error("🛑 FATAL: FINAL BATCH INSERT FAILED AFTER ALL RETRIES");
      console.error("═".repeat(60));
      console.error(`   Batch #${batchNumber} (final) failed permanently`);
      console.error(`   Error: ${batchError.message}`);
      console.error(`   Error code: ${batchError.code || "N/A"}`);
      console.error(`   Records imported before failure: ${formatNumber(imported)}`);
      console.error("═".repeat(60));
      console.error("\n💡 To resume: Fix the issue and re-run the script.\n");
      await pool.end();
      process.exit(1);
    }
  }

  const totalTime = Date.now() - startImport;
  console.log("\n");
  console.log("─".repeat(60));
  console.log("✅ Import complete!");
  console.log();
  console.log("📊 Summary:");
  console.log(`   • Records imported: ${formatNumber(imported)}`);
  console.log(`   • Batches processed: ${formatNumber(batchNumber)}`);
  console.log(`   • Retries needed: ${formatNumber(totalRetries)}`);
  console.log(`   • Parse errors (skipped): ${formatNumber(parseErrors)}`);
  console.log(`   • Total time: ${formatDuration(totalTime)}`);
  console.log(`   • Average rate: ${formatNumber(Math.round(imported / (totalTime / 1000)))}/sec`);

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
