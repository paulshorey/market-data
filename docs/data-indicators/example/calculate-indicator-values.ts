// scripts/calculate-rsi.ts

import { Pool, PoolClient } from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { Readable } from "stream";

// ============================================================================
// Types
// ============================================================================

interface PriceRow {
  timestamp: Date;
  symbol: string;
  minute_index: number;
  close: number;
}

interface RSIUpdate {
  timestamp: Date;
  symbol: string;
  rsi_14: number;
}

// ============================================================================
// RSI Calculator (Wilder's Smoothing Method)
// ============================================================================

class RSICalculator {
  private period: number;
  private prices: number[] = [];
  private avgGain: number | null = null;
  private avgLoss: number | null = null;
  private initialized: boolean = false;

  constructor(period: number = 14) {
    this.period = period;
  }

  /**
   * Add a new price and return the RSI value (or null if not enough data)
   */
  push(price: number): number | null {
    this.prices.push(price);

    // Need at least period + 1 prices to calculate first RSI
    // (period changes require period + 1 prices)
    if (this.prices.length < this.period + 1) {
      return null;
    }

    if (!this.initialized) {
      // First RSI: simple average of gains and losses over the period
      let gains = 0;
      let losses = 0;

      for (let i = 1; i <= this.period; i++) {
        const change = this.prices[i] - this.prices[i - 1];
        if (change > 0) {
          gains += change;
        } else {
          losses += Math.abs(change);
        }
      }

      this.avgGain = gains / this.period;
      this.avgLoss = losses / this.period;
      this.initialized = true;

      // Remove oldest price, keep only what we need for next calculation
      this.prices = [this.prices[this.prices.length - 1]];
    } else {
      // Subsequent RSI: Wilder's smoothing
      const change = this.prices[this.prices.length - 1] - this.prices[this.prices.length - 2];
      const currentGain = change > 0 ? change : 0;
      const currentLoss = change < 0 ? Math.abs(change) : 0;

      // Exponential moving average (Wilder's smoothing)
      this.avgGain = (this.avgGain! * (this.period - 1) + currentGain) / this.period;
      this.avgLoss = (this.avgLoss! * (this.period - 1) + currentLoss) / this.period;

      // Keep only the last price for next iteration
      this.prices = [this.prices[this.prices.length - 1]];
    }

    // Calculate RSI
    if (this.avgLoss === 0) {
      return 100; // No losses means RSI is 100
    }

    const rs = this.avgGain! / this.avgLoss!;
    const rsi = 100 - 100 / (1 + rs);

    return rsi;
  }

  /**
   * Reset the calculator state
   */
  reset(): void {
    this.prices = [];
    this.avgGain = null;
    this.avgLoss = null;
    this.initialized = false;
  }

  /**
   * Get the number of prices needed before first RSI is produced
   */
  getWarmupPeriod(): number {
    return this.period + 1;
  }
}

// ============================================================================
// Database Operations
// ============================================================================

async function getMinuteIndexRange(client: PoolClient, tableName: string, symbol: string): Promise<{ min: number; max: number } | null> {
  const result = await client.query<{ min_idx: number; max_idx: number }>(
    `
    SELECT 
      MIN(minute_index) as min_idx,
      MAX(minute_index) as max_idx
    FROM ${tableName}
    WHERE symbol = $1
  `,
    [symbol],
  );

  if (result.rows[0]?.min_idx === null) {
    return null;
  }

  return {
    min: result.rows[0].min_idx,
    max: result.rows[0].max_idx,
  };
}

async function getRowCountForMinuteIndex(client: PoolClient, tableName: string, symbol: string, minuteIndex: number): Promise<number> {
  const result = await client.query<{ count: string }>(
    `
    SELECT COUNT(*) as count
    FROM ${tableName}
    WHERE symbol = $1 AND minute_index = $2
  `,
    [symbol, minuteIndex],
  );

  return parseInt(result.rows[0].count, 10);
}

async function* streamPricesForMinuteIndex(
  client: PoolClient,
  tableName: string,
  symbol: string,
  minuteIndex: number,
  batchSize: number = 50000,
): AsyncGenerator<PriceRow[]> {
  let lastTimestamp: Date | null = null;
  let hasMore = true;

  while (hasMore) {
    // Use the composite index: (symbol, minute_index, timestamp)
    const query = lastTimestamp
      ? `
        SELECT timestamp, symbol, minute_index, close
        FROM ${tableName}
        WHERE symbol = $1 
          AND minute_index = $2 
          AND timestamp > $3
        ORDER BY timestamp ASC
        LIMIT $4
      `
      : `
        SELECT timestamp, symbol, minute_index, close
        FROM ${tableName}
        WHERE symbol = $1 
          AND minute_index = $2
        ORDER BY timestamp ASC
        LIMIT $3
      `;

    const params = lastTimestamp ? [symbol, minuteIndex, lastTimestamp, batchSize] : [symbol, minuteIndex, batchSize];

    const result = await client.query<PriceRow>(query, params);

    if (result.rows.length === 0) {
      hasMore = false;
    } else {
      lastTimestamp = result.rows[result.rows.length - 1].timestamp;
      yield result.rows;

      if (result.rows.length < batchSize) {
        hasMore = false;
      }
    }
  }
}

// ============================================================================
// Bulk Update via Staging Table + COPY
// ============================================================================

async function bulkUpdateRSI(client: PoolClient, tableName: string, updates: RSIUpdate[]): Promise<number> {
  if (updates.length === 0) return 0;

  // Create temp staging table
  await client.query(`
    CREATE TEMP TABLE staging_rsi (
      timestamp TIMESTAMPTZ NOT NULL,
      symbol VARCHAR(20) NOT NULL,
      rsi_14 DOUBLE PRECISION NOT NULL
    ) ON COMMIT DROP
  `);

  // Bulk load via COPY
  await new Promise<void>((resolve, reject) => {
    const copyQuery = `
      COPY staging_rsi (timestamp, symbol, rsi_14)
      FROM STDIN WITH (FORMAT text)
    `;

    const stream = client.query(copyFrom(copyQuery));

    const data = updates.map((u) => `${u.timestamp.toISOString()}\t${u.symbol}\t${u.rsi_14}`).join("\n") + "\n";

    const readable = Readable.from([data]);

    stream.on("finish", resolve);
    stream.on("error", reject);
    readable.on("error", reject);

    readable.pipe(stream);
  });

  // Create index on staging table for efficient join
  await client.query(`
    CREATE INDEX ON staging_rsi (symbol, timestamp)
  `);

  // Bulk update via JOIN
  const result = await client.query(`
    UPDATE ${tableName} m
    SET rsi_14 = s.rsi_14
    FROM staging_rsi s
    WHERE m.symbol = s.symbol 
      AND m.timestamp = s.timestamp
  `);

  return result.rowCount ?? 0;
}

// ============================================================================
// Process Single Minute Index
// ============================================================================

async function processMinuteIndex(
  pool: Pool,
  tableName: string,
  symbol: string,
  minuteIndex: number,
  rsiPeriod: number = 14,
  updateBatchSize: number = 10000,
): Promise<{ processed: number; updated: number; skipped: number }> {
  const client = await pool.connect();

  try {
    const calculator = new RSICalculator(rsiPeriod);
    let pendingUpdates: RSIUpdate[] = [];
    let totalProcessed = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;

    await client.query("BEGIN");

    for await (const batch of streamPricesForMinuteIndex(client, tableName, symbol, minuteIndex)) {
      for (const row of batch) {
        totalProcessed++;

        const rsi = calculator.push(row.close);

        if (rsi === null) {
          // Not enough data yet (warmup period)
          totalSkipped++;
          continue;
        }

        pendingUpdates.push({
          timestamp: row.timestamp,
          symbol: row.symbol,
          rsi_14: rsi,
        });

        // Batch update when we have enough
        if (pendingUpdates.length >= updateBatchSize) {
          const updated = await bulkUpdateRSI(client, tableName, pendingUpdates);
          totalUpdated += updated;
          pendingUpdates = [];
        }
      }
    }

    // Final batch
    if (pendingUpdates.length > 0) {
      const updated = await bulkUpdateRSI(client, tableName, pendingUpdates);
      totalUpdated += updated;
    }

    await client.query("COMMIT");

    return {
      processed: totalProcessed,
      updated: totalUpdated,
      skipped: totalSkipped,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// ============================================================================
// Main Processing with Parallelization Option
// ============================================================================

interface ProcessingStats {
  minuteIndex: number;
  processed: number;
  updated: number;
  skipped: number;
  durationMs: number;
}

async function processAllMinuteIndexes(
  pool: Pool,
  tableName: string,
  symbol: string,
  interval: number,
  rsiPeriod: number = 14,
  parallelism: number = 4,
): Promise<void> {
  const client = await pool.connect();

  try {
    // Verify table exists and get minute_index range
    const range = await getMinuteIndexRange(client, tableName, symbol);

    if (!range) {
      console.error(`No data found for symbol ${symbol} in ${tableName}`);
      return;
    }

    console.log(`Minute index range: ${range.min} to ${range.max}`);

    // Generate list of minute indexes to process
    const minuteIndexes: number[] = [];
    for (let i = range.min; i <= range.max; i++) {
      minuteIndexes.push(i);
    }

    console.log(`\nProcessing ${minuteIndexes.length} minute indexes with parallelism=${parallelism}\n`);
  } finally {
    client.release();
  }

  // Process in parallel batches
  const startTime = Date.now();
  const allStats: ProcessingStats[] = [];
  let completedCount = 0;

  // Create work queue
  const queue = [...Array(interval).keys()]; // [0, 1, 2, ..., interval-1]

  // Worker function
  async function worker(workerId: number): Promise<void> {
    while (queue.length > 0) {
      const minuteIndex = queue.shift();
      if (minuteIndex === undefined) break;

      const workerStart = Date.now();

      try {
        const stats = await processMinuteIndex(pool, tableName, symbol, minuteIndex, rsiPeriod);

        const duration = Date.now() - workerStart;
        completedCount++;

        allStats.push({
          minuteIndex,
          ...stats,
          durationMs: duration,
        });

        const pct = ((completedCount / interval) * 100).toFixed(1);
        console.log(
          `[Worker ${workerId}] minute_index=${minuteIndex.toString().padStart(3)} | ` +
            `processed=${stats.processed.toLocaleString().padStart(8)} | ` +
            `updated=${stats.updated.toLocaleString().padStart(8)} | ` +
            `skipped=${stats.skipped.toString().padStart(3)} | ` +
            `${duration}ms | ` +
            `${pct}% complete`,
        );
      } catch (error) {
        console.error(`[Worker ${workerId}] Error processing minute_index=${minuteIndex}:`, error);
        throw error;
      }
    }
  }

  // Launch parallel workers
  const workers: Promise<void>[] = [];
  for (let i = 0; i < parallelism; i++) {
    workers.push(worker(i));
  }

  await Promise.all(workers);

  // Summary
  const totalElapsed = (Date.now() - startTime) / 1000;
  const totalProcessed = allStats.reduce((sum, s) => sum + s.processed, 0);
  const totalUpdated = allStats.reduce((sum, s) => sum + s.updated, 0);
  const totalSkipped = allStats.reduce((sum, s) => sum + s.skipped, 0);

  console.log(`\n${"=".repeat(70)}`);
  console.log(`RSI Calculation Complete`);
  console.log(`${"=".repeat(70)}`);
  console.log(`Table:            ${tableName}`);
  console.log(`Symbol:           ${symbol}`);
  console.log(`RSI Period:       ${rsiPeriod}`);
  console.log(`Minute Indexes:   ${interval}`);
  console.log(`Parallelism:      ${parallelism}`);
  console.log(`Total Processed:  ${totalProcessed.toLocaleString()}`);
  console.log(`Total Updated:    ${totalUpdated.toLocaleString()}`);
  console.log(`Total Skipped:    ${totalSkipped.toLocaleString()} (warmup period)`);
  console.log(`Total Time:       ${totalElapsed.toFixed(1)} seconds`);
  console.log(`Throughput:       ${Math.round(totalProcessed / totalElapsed).toLocaleString()} rows/sec`);

  // Run ANALYZE
  const analyzeClient = await pool.connect();
  try {
    console.log(`\nRunning ANALYZE on ${tableName}...`);
    await analyzeClient.query(`ANALYZE ${tableName}`);
    console.log(`Statistics updated.`);
  } finally {
    analyzeClient.release();
  }
}

// ============================================================================
// Verify RSI Calculations
// ============================================================================

async function verifyRSI(pool: Pool, tableName: string, symbol: string, minuteIndex: number, limit: number = 20): Promise<void> {
  const client = await pool.connect();

  try {
    // Get sample data to verify
    const result = await client.query<{
      timestamp: Date;
      close: number;
      rsi_14: number | null;
    }>(
      `
      SELECT timestamp, close, rsi_14
      FROM ${tableName}
      WHERE symbol = $1 AND minute_index = $2
      ORDER BY timestamp ASC
      LIMIT $3
    `,
      [symbol, minuteIndex, limit + 15],
    ); // Extra rows for warmup

    console.log(`\nVerification for ${symbol} minute_index=${minuteIndex}:`);
    console.log("-".repeat(60));
    console.log("Timestamp                    | Close     | RSI_14");
    console.log("-".repeat(60));

    // Manually calculate RSI to verify
    const calculator = new RSICalculator(14);

    for (const row of result.rows) {
      const calculatedRSI = calculator.push(row.close);
      const storedRSI = row.rsi_14;

      const match =
        calculatedRSI === null && storedRSI === null
          ? "✓"
          : calculatedRSI !== null && storedRSI !== null && Math.abs(calculatedRSI - storedRSI) < 0.0001
            ? "✓"
            : "✗";

      console.log(
        `${row.timestamp.toISOString()} | ` +
          `${row.close.toFixed(2).padStart(9)} | ` +
          `${storedRSI?.toFixed(2).padStart(6) ?? "NULL".padStart(6)} ` +
          `(calc: ${calculatedRSI?.toFixed(2) ?? "NULL"}) ${match}`,
      );
    }
  } finally {
    client.release();
  }
}

// ============================================================================
// Entry Point
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error("Usage: npx ts-node scripts/calculate-rsi.ts <ticker> <interval> [options]");
    console.error("");
    console.error("Examples:");
    console.error("  npx ts-node scripts/calculate-rsi.ts ES 60");
    console.error("  npx ts-node scripts/calculate-rsi.ts ES 60 --parallelism 8");
    console.error("  npx ts-node scripts/calculate-rsi.ts ES 60 --verify --minute-index 45");
    console.error("");
    console.error("Options:");
    console.error("  --parallelism N    Number of parallel workers (default: 4)");
    console.error("  --rsi-period N     RSI period (default: 14)");
    console.error("  --verify           Verify RSI calculations");
    console.error("  --minute-index N   Specific minute_index to process or verify");
    process.exit(1);
  }

  const symbol = args[0];
  const interval = parseInt(args[1], 10);

  if (isNaN(interval) || interval < 2) {
    console.error("Interval must be an integer >= 2");
    process.exit(1);
  }

  // Parse options
  const parallelismIdx = args.indexOf("--parallelism");
  const parallelism = parallelismIdx !== -1 ? parseInt(args[parallelismIdx + 1], 10) : 4;

  const rsiPeriodIdx = args.indexOf("--rsi-period");
  const rsiPeriod = rsiPeriodIdx !== -1 ? parseInt(args[rsiPeriodIdx + 1], 10) : 14;

  const verifyMode = args.includes("--verify");

  const minuteIndexIdx = args.indexOf("--minute-index");
  const specificMinuteIndex = minuteIndexIdx !== -1 ? parseInt(args[minuteIndexIdx + 1], 10) : null;

  const tableName = `ohlcv_${interval}m`;

  const pool = new Pool({
    host: process.env.PGHOST || "localhost",
    port: parseInt(process.env.PGPORT || "5432", 10),
    database: process.env.PGDATABASE || "trading",
    user: process.env.PGUSER || "postgres",
    password: process.env.PGPASSWORD || "",
    max: parallelism + 2, // Extra connections for monitoring
  });

  try {
    if (verifyMode) {
      // Verification mode
      const indexToVerify = specificMinuteIndex ?? 0;
      await verifyRSI(pool, tableName, symbol, indexToVerify);
    } else if (specificMinuteIndex !== null) {
      // Process single minute_index
      console.log(`\nProcessing ${symbol} ${tableName} minute_index=${specificMinuteIndex}`);
      console.log(`RSI Period: ${rsiPeriod}\n`);

      const startTime = Date.now();
      const stats = await processMinuteIndex(pool, tableName, symbol, specificMinuteIndex, rsiPeriod);
      const elapsed = (Date.now() - startTime) / 1000;

      console.log(`\nComplete!`);
      console.log(`Processed: ${stats.processed.toLocaleString()}`);
      console.log(`Updated:   ${stats.updated.toLocaleString()}`);
      console.log(`Skipped:   ${stats.skipped.toLocaleString()}`);
      console.log(`Time:      ${elapsed.toFixed(1)} seconds`);
    } else {
      // Process all minute_indexes
      console.log(`\n${"=".repeat(70)}`);
      console.log(`Calculating RSI(${rsiPeriod}) for ${symbol} in ${tableName}`);
      console.log(`${"=".repeat(70)}`);

      await processAllMinuteIndexes(pool, tableName, symbol, interval, rsiPeriod, parallelism);
    }
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
