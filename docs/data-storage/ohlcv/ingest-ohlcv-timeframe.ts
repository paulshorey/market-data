// scripts/ingest-ohlcv-timeframe.ts

import { Pool, PoolClient } from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { Readable } from "stream";

// ============================================================================
// Types
// ============================================================================

interface OHLCVRow {
  timestamp: Date;
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trade_count: number | null;
  vwap: number | null;
  minutes_into_session: number | null;
  is_regular_session: boolean;
  has_gap_from_prior_session: boolean;
}

interface WindowRow {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trade_count: number;
  vwap_volume_sum: number;
}

interface OutputRow {
  timestamp: Date;
  symbol: string;
  minute_index: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trade_count: number;
  vwap: number | null;
  minutes_into_session: number | null;
  window_spans_sessions: boolean;
  is_regular_session: boolean;
  has_gap_from_prior_session: boolean;
}

// ============================================================================
// Monotonic Deque for O(1) Sliding Max/Min
// ============================================================================

class MonotonicDeque {
  private deque: { index: number; value: number }[] = [];
  private comparator: (a: number, b: number) => boolean;

  constructor(type: "max" | "min") {
    this.comparator = type === "max" ? (a, b) => a >= b : (a, b) => a <= b;
  }

  push(index: number, value: number): void {
    while (this.deque.length > 0 && !this.comparator(this.deque[this.deque.length - 1].value, value)) {
      this.deque.pop();
    }
    this.deque.push({ index, value });
  }

  removeOld(minIndex: number): void {
    while (this.deque.length > 0 && this.deque[0].index < minIndex) {
      this.deque.shift();
    }
  }

  get(): number | undefined {
    return this.deque.length > 0 ? this.deque[0].value : undefined;
  }
}

// ============================================================================
// Sliding Window Calculator
// ============================================================================

class SlidingWindowOHLCV {
  private windowSize: number;
  private buffer: WindowRow[] = [];
  private bufferStart: number = 0;
  private maxDeque: MonotonicDeque;
  private minDeque: MonotonicDeque;
  private volumeSum: number = 0;
  private tradeCountSum: number = 0;
  private vwapVolumeSum: number = 0;

  constructor(windowSize: number) {
    this.windowSize = windowSize;
    this.maxDeque = new MonotonicDeque("max");
    this.minDeque = new MonotonicDeque("min");
  }

  push(row: WindowRow): void {
    const globalIndex = this.bufferStart + this.buffer.length;

    this.buffer.push(row);
    this.volumeSum += row.volume;
    this.tradeCountSum += row.trade_count;
    this.vwapVolumeSum += row.vwap_volume_sum;

    this.maxDeque.push(globalIndex, row.high);
    this.minDeque.push(globalIndex, row.low);

    if (this.buffer.length > this.windowSize) {
      const removed = this.buffer.shift()!;
      this.bufferStart++;
      this.volumeSum -= removed.volume;
      this.tradeCountSum -= removed.trade_count;
      this.vwapVolumeSum -= removed.vwap_volume_sum;

      this.maxDeque.removeOld(this.bufferStart);
      this.minDeque.removeOld(this.bufferStart);
    }
  }

  isFull(): boolean {
    return this.buffer.length >= this.windowSize;
  }

  getWindowOHLCV(): {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    trade_count: number;
    vwap: number | null;
  } | null {
    if (this.buffer.length === 0) return null;

    const oldest = this.buffer[0];
    const newest = this.buffer[this.buffer.length - 1];

    return {
      open: oldest.open,
      high: this.maxDeque.get()!,
      low: this.minDeque.get()!,
      close: newest.close,
      volume: this.volumeSum,
      trade_count: this.tradeCountSum,
      vwap: this.volumeSum > 0 ? this.vwapVolumeSum / this.volumeSum : null,
    };
  }

  getOldestTimestamp(): Date | null {
    return this.buffer.length > 0 ? this.buffer[0].timestamp : null;
  }
}

// ============================================================================
// Partition Management
// ============================================================================

function getMonthlyPartitionBounds(date: Date): { start: Date; end: Date; suffix: string } {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();

  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));
  const suffix = `${year}_${String(month + 1).padStart(2, "0")}`;

  return { start, end, suffix };
}

async function ensurePartitionedTableExists(client: PoolClient, interval: number): Promise<void> {
  const parentTable = `ohlcv_${interval}m`;

  // Create parent table with LIST partitioning by symbol
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${parentTable} (
      timestamp TIMESTAMPTZ NOT NULL,
      symbol VARCHAR(20) NOT NULL,
      minute_index SMALLINT NOT NULL,
      
      open DOUBLE PRECISION NOT NULL,
      high DOUBLE PRECISION NOT NULL,
      low DOUBLE PRECISION NOT NULL,
      close DOUBLE PRECISION NOT NULL,
      volume DOUBLE PRECISION NOT NULL,
      
      trade_count INTEGER,
      vwap DOUBLE PRECISION,
      
      -- Indicator columns (not indexed, for HOT updates)
      rsi_14 DOUBLE PRECISION,
      atr_14 DOUBLE PRECISION,
      cvd DOUBLE PRECISION,
      
      minutes_into_session SMALLINT,
      window_minutes SMALLINT DEFAULT ${interval},
      window_spans_sessions BOOLEAN DEFAULT FALSE,
      
      is_regular_session BOOLEAN DEFAULT TRUE,
      has_gap_from_prior_session BOOLEAN DEFAULT FALSE,
      
      PRIMARY KEY (symbol, timestamp)
    ) PARTITION BY LIST (symbol)
    WITH (fillfactor = 70)
  `);

  // Configure autovacuum for update-heavy workload
  await client
    .query(
      `
    ALTER TABLE ${parentTable} SET (
      autovacuum_vacuum_scale_factor = 0,
      autovacuum_vacuum_threshold = 500000,
      autovacuum_analyze_scale_factor = 0,
      autovacuum_analyze_threshold = 500000
    )
  `,
    )
    .catch(() => {
      // Ignore if already set
    });
}

async function ensureSymbolPartitionExists(client: PoolClient, interval: number, symbol: string): Promise<string> {
  const parentTable = `ohlcv_${interval}m`;
  const symbolPartition = `${parentTable}_${symbol.toLowerCase()}`;

  // Check if symbol partition exists
  const exists = await client.query(
    `
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = $1 AND n.nspname = 'public'
  `,
    [symbolPartition],
  );

  if (exists.rows.length === 0) {
    // Create symbol partition with RANGE sub-partitioning by timestamp
    await client.query(`
      CREATE TABLE ${symbolPartition} PARTITION OF ${parentTable}
      FOR VALUES IN ('${symbol}')
      PARTITION BY RANGE (timestamp)
      WITH (fillfactor = 70)
    `);

    console.log(`Created symbol partition: ${symbolPartition}`);
  }

  return symbolPartition;
}

async function ensureMonthPartitionExists(client: PoolClient, symbolPartition: string, date: Date): Promise<string> {
  const { start, end, suffix } = getMonthlyPartitionBounds(date);
  const monthPartition = `${symbolPartition}_${suffix}`;

  // Check if month partition exists
  const exists = await client.query(
    `
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = $1 AND n.nspname = 'public'
  `,
    [monthPartition],
  );

  if (exists.rows.length === 0) {
    await client.query(`
      CREATE TABLE ${monthPartition} PARTITION OF ${symbolPartition}
      FOR VALUES FROM ('${start.toISOString()}') TO ('${end.toISOString()}')
      WITH (fillfactor = 70)
    `);

    console.log(`Created month partition: ${monthPartition}`);
  }

  return monthPartition;
}

async function createIndexesIfNotExist(client: PoolClient, interval: number): Promise<void> {
  const tableName = `ohlcv_${interval}m`;

  // B-tree composite index for query pattern: WHERE symbol = x AND minute_index = y AND timestamp BETWEEN a AND b
  // Column order: equality columns first (symbol, minute_index), range column last (timestamp)
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_${tableName}_lookup 
    ON ${tableName} (symbol, minute_index, timestamp)
  `);

  // Additional index for timestamp-only queries within a symbol
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_${tableName}_symbol_time
    ON ${tableName} (symbol, timestamp)
  `);

  console.log(`Ensured indexes exist on ${tableName}`);
}

// ============================================================================
// Database Operations
// ============================================================================

async function getTimestampRange(client: PoolClient, symbol: string): Promise<{ first: Date; last: Date } | null> {
  const result = await client.query<{ first_ts: Date; last_ts: Date }>(
    `
    SELECT 
      MIN(timestamp) as first_ts,
      MAX(timestamp) as last_ts
    FROM ohlcv_1m
    WHERE symbol = $1
  `,
    [symbol],
  );

  if (!result.rows[0]?.first_ts || !result.rows[0]?.last_ts) {
    return null;
  }

  return {
    first: result.rows[0].first_ts,
    last: result.rows[0].last_ts,
  };
}

async function getLastMinuteIndex(client: PoolClient, tableName: string, symbol: string): Promise<number | null> {
  const result = await client.query<{ minute_index: number }>(
    `
    SELECT minute_index
    FROM ${tableName}
    WHERE symbol = $1
    ORDER BY timestamp DESC
    LIMIT 1
  `,
    [symbol],
  );

  return result.rows[0]?.minute_index ?? null;
}

async function* streamSourceData(client: PoolClient, symbol: string, batchSize: number = 50000): AsyncGenerator<OHLCVRow[]> {
  let lastTimestamp: Date | null = null;
  let hasMore = true;

  while (hasMore) {
    const query = lastTimestamp
      ? `
        SELECT 
          timestamp, symbol, open, high, low, close, volume,
          trade_count, vwap, minutes_into_session,
          is_regular_session, has_gap_from_prior_session
        FROM ohlcv_1m
        WHERE symbol = $1 AND timestamp > $2
        ORDER BY timestamp ASC
        LIMIT $3
      `
      : `
        SELECT 
          timestamp, symbol, open, high, low, close, volume,
          trade_count, vwap, minutes_into_session,
          is_regular_session, has_gap_from_prior_session
        FROM ohlcv_1m
        WHERE symbol = $1
        ORDER BY timestamp ASC
        LIMIT $2
      `;

    const params = lastTimestamp ? [symbol, lastTimestamp, batchSize] : [symbol, batchSize];

    const result = await client.query<OHLCVRow>(query, params);

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
// Bulk Insert via COPY
// ============================================================================

function formatRowForCopy(row: OutputRow): string {
  // Format: timestamp, symbol, minute_index, open, high, low, close, volume,
  //         trade_count, vwap, minutes_into_session, window_spans_sessions,
  //         is_regular_session, has_gap_from_prior_session

  const values = [
    row.timestamp.toISOString(),
    row.symbol,
    row.minute_index,
    row.open,
    row.high,
    row.low,
    row.close,
    row.volume,
    row.trade_count ?? "\\N", // NULL representation in COPY
    row.vwap?.toFixed(6) ?? "\\N",
    row.minutes_into_session ?? "\\N",
    row.window_spans_sessions,
    row.is_regular_session,
    row.has_gap_from_prior_session,
  ];

  return values.join("\t");
}

async function bulkInsertViaCopy(client: PoolClient, tableName: string, rows: OutputRow[]): Promise<number> {
  if (rows.length === 0) return 0;

  return new Promise((resolve, reject) => {
    const copyQuery = `
      COPY ${tableName} (
        timestamp, symbol, minute_index,
        open, high, low, close, volume,
        trade_count, vwap,
        minutes_into_session, window_spans_sessions,
        is_regular_session, has_gap_from_prior_session
      ) FROM STDIN WITH (FORMAT text, NULL '\\N')
    `;

    const stream = client.query(copyFrom(copyQuery));

    const data = rows.map(formatRowForCopy).join("\n") + "\n";
    const readable = Readable.from([data]);

    stream.on("finish", () => resolve(rows.length));
    stream.on("error", reject);
    readable.on("error", reject);

    readable.pipe(stream);
  });
}

// ============================================================================
// Main Processing
// ============================================================================

async function processData(pool: Pool, symbol: string, interval: number): Promise<void> {
  const client = await pool.connect();
  const parentTable = `ohlcv_${interval}m`;
  const COPY_BATCH_SIZE = 10000;

  // Track which month partitions we've created
  const createdPartitions = new Set<string>();

  try {
    // Get timestamp range
    console.log(`Fetching timestamp range for ${symbol}...`);
    const range = await getTimestampRange(client, symbol);

    if (!range) {
      console.error(`No data found for symbol ${symbol} in ohlcv_1m`);
      return;
    }

    console.log(`Data range: ${range.first.toISOString()} to ${range.last.toISOString()}`);

    const totalDays = Math.ceil((range.last.getTime() - range.first.getTime()) / (1000 * 60 * 60 * 24));
    console.log(`Approximately ${totalDays} days of data`);

    // Ensure partitioned table structure exists
    console.log(`\nSetting up partitioned table ${parentTable}...`);
    await ensurePartitionedTableExists(client, interval);

    // Create symbol partition
    const symbolPartition = await ensureSymbolPartitionExists(client, interval, symbol);

    // Pre-create all needed month partitions based on data range
    console.log(`\nPre-creating month partitions...`);
    let currentMonth = new Date(range.first);
    while (currentMonth <= range.last) {
      const partitionName = await ensureMonthPartitionExists(client, symbolPartition, currentMonth);
      createdPartitions.add(partitionName);
      currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1);
    }
    console.log(`Created ${createdPartitions.size} month partitions`);

    // Create indexes after partitions exist
    console.log(`\nCreating indexes...`);
    await createIndexesIfNotExist(client, interval);

    // Get last minute_index if resuming
    const lastIndex = await getLastMinuteIndex(client, parentTable, symbol);
    let minuteIndex = lastIndex !== null ? (lastIndex + 1) % interval : 0;

    if (lastIndex !== null) {
      console.log(`Resuming from minute_index ${minuteIndex} (last was ${lastIndex})`);
    } else {
      console.log(`Starting fresh with minute_index 0`);
    }

    // Initialize sliding window
    const slidingWindow = new SlidingWindowOHLCV(interval);

    // Process data
    let totalProcessed = 0;
    let totalInserted = 0;
    let pendingInserts: OutputRow[] = [];
    let lastLogTime = Date.now();
    const startTime = Date.now();

    console.log(`\nProcessing ${symbol} with ${interval}-minute rolling window...`);
    console.log(`Using COPY for bulk inserts (batch size: ${COPY_BATCH_SIZE})\n`);

    for await (const batch of streamSourceData(client, symbol)) {
      for (const row of batch) {
        // Add to sliding window
        slidingWindow.push({
          timestamp: row.timestamp,
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          volume: row.volume,
          trade_count: row.trade_count ?? 0,
          vwap_volume_sum: (row.vwap ?? row.close) * row.volume,
        });

        totalProcessed++;

        // Only output once window is full
        if (!slidingWindow.isFull()) {
          continue;
        }

        const windowData = slidingWindow.getWindowOHLCV()!;
        const oldestTs = slidingWindow.getOldestTimestamp()!;

        // Detect if window spans sessions
        const clockMinutes = (row.timestamp.getTime() - oldestTs.getTime()) / (1000 * 60);
        const windowSpansSessions = clockMinutes > interval * 1.5;

        pendingInserts.push({
          timestamp: row.timestamp,
          symbol: row.symbol,
          minute_index: minuteIndex,
          open: windowData.open,
          high: windowData.high,
          low: windowData.low,
          close: windowData.close,
          volume: windowData.volume,
          trade_count: windowData.trade_count,
          vwap: windowData.vwap,
          minutes_into_session: row.minutes_into_session,
          window_spans_sessions: windowSpansSessions,
          is_regular_session: row.is_regular_session,
          has_gap_from_prior_session: row.has_gap_from_prior_session,
        });

        // Increment minute_index
        minuteIndex = (minuteIndex + 1) % interval;

        // Bulk insert via COPY when batch is ready
        if (pendingInserts.length >= COPY_BATCH_SIZE) {
          const inserted = await bulkInsertViaCopy(client, parentTable, pendingInserts);
          totalInserted += inserted;
          pendingInserts = [];
        }
      }

      // Progress logging every 5 seconds
      const now = Date.now();
      if (now - lastLogTime > 5000) {
        const elapsedSec = (now - startTime) / 1000;
        const rowsPerSec = Math.round(totalProcessed / elapsedSec);
        const pctComplete = ((totalProcessed / (totalDays * 390)) * 100).toFixed(1);

        console.log(
          `Processed ${totalProcessed.toLocaleString()} rows ` +
            `(~${pctComplete}%) | ` +
            `Inserted ${totalInserted.toLocaleString()} | ` +
            `${rowsPerSec.toLocaleString()} rows/sec`,
        );
        lastLogTime = now;
      }
    }

    // Insert remaining rows
    if (pendingInserts.length > 0) {
      const inserted = await bulkInsertViaCopy(client, parentTable, pendingInserts);
      totalInserted += inserted;
    }

    // Final stats
    const totalElapsed = (Date.now() - startTime) / 1000;
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Complete!`);
    console.log(`${"=".repeat(60)}`);
    console.log(`Total source rows processed: ${totalProcessed.toLocaleString()}`);
    console.log(`Total rows inserted into ${parentTable}: ${totalInserted.toLocaleString()}`);
    console.log(`Rows skipped (window warmup): ${(totalProcessed - totalInserted).toLocaleString()}`);
    console.log(`Total time: ${totalElapsed.toFixed(1)} seconds`);
    console.log(`Average throughput: ${Math.round(totalProcessed / totalElapsed).toLocaleString()} rows/sec`);

    // Run ANALYZE to update statistics
    console.log(`\nRunning ANALYZE on ${parentTable}...`);
    await client.query(`ANALYZE ${parentTable}`);
    console.log(`Statistics updated.`);
  } finally {
    client.release();
  }
}

// ============================================================================
// Utility: Create All Partitions for Multiple Symbols
// ============================================================================

async function setupAllPartitions(pool: Pool, interval: number, symbols: string[], startDate: Date, endDate: Date): Promise<void> {
  const client = await pool.connect();

  try {
    console.log(`Setting up partitions for ${symbols.length} symbols...`);

    await ensurePartitionedTableExists(client, interval);

    for (const symbol of symbols) {
      const symbolPartition = await ensureSymbolPartitionExists(client, interval, symbol);

      let currentMonth = new Date(startDate);
      while (currentMonth <= endDate) {
        await ensureMonthPartitionExists(client, symbolPartition, currentMonth);
        currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1);
      }

      console.log(`  Created partitions for ${symbol}`);
    }

    await createIndexesIfNotExist(client, interval);
    console.log(`\nPartition setup complete.`);
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
    console.error("Usage: npx ts-node scripts/import-custom-ohlcv.ts <ticker> <interval>");
    console.error("Example: npx ts-node scripts/import-custom-ohlcv.ts ES 60");
    console.error("\nOptions:");
    console.error("  --setup-only    Only create partitions, do not import data");
    console.error("  --symbols       Comma-separated list of symbols for --setup-only");
    console.error("  --start-date    Start date for partitions (YYYY-MM-DD)");
    console.error("  --end-date      End date for partitions (YYYY-MM-DD)");
    process.exit(1);
  }

  const symbol = args[0];
  const interval = parseInt(args[1], 10);

  if (isNaN(interval) || interval < 2) {
    console.error("Interval must be an integer >= 2");
    process.exit(1);
  }

  const pool = new Pool({
    host: process.env.PGHOST || "localhost",
    port: parseInt(process.env.PGPORT || "5432", 10),
    database: process.env.PGDATABASE || "trading",
    user: process.env.PGUSER || "postgres",
    password: process.env.PGPASSWORD || "",
  });

  try {
    // Check for --setup-only flag
    if (args.includes("--setup-only")) {
      const symbolsIdx = args.indexOf("--symbols");
      const startIdx = args.indexOf("--start-date");
      const endIdx = args.indexOf("--end-date");

      const symbols = symbolsIdx !== -1 ? args[symbolsIdx + 1].split(",") : [symbol];
      const startDate = startIdx !== -1 ? new Date(args[startIdx + 1]) : new Date("2014-01-01");
      const endDate = endIdx !== -1 ? new Date(args[endIdx + 1]) : new Date("2027-01-01");

      await setupAllPartitions(pool, interval, symbols, startDate, endDate);
    } else {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`Importing ${symbol} with ${interval}-minute rolling window`);
      console.log(`${"=".repeat(60)}\n`);

      await processData(pool, symbol, interval);
    }
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
