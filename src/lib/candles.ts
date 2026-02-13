import { pool } from "./db.js";

interface Timeframe {
  id: string;
  table: string;
  ms: number;
}

/**
 * Timeframe configurations
 * candles_1m is the base hypertable (written at 1-second resolution).
 * Higher timeframes are TimescaleDB continuous aggregates.
 */
export const TIMEFRAMES: Timeframe[] = [
  { id: "1m", table: "candles_1m", ms: 60 * 1000 },
  { id: "5m", table: "candles_5m", ms: 5 * 60 * 1000 },
  { id: "15m", table: "candles_15m", ms: 15 * 60 * 1000 },
  { id: "1h", table: "candles_1h", ms: 60 * 60 * 1000 },
  { id: "1d", table: "candles_1d", ms: 24 * 60 * 60 * 1000 },
];

// Target number of candles to return (aim for good chart density)
export const TARGET_CANDLES = 1000;

/**
 * Select the best timeframe based on requested date range
 * Returns the smallest timeframe that keeps results under target
 */
export function selectTimeframe(startMs: number, endMs: number): Timeframe {
  const rangeMs = endMs - startMs;

  // Find the smallest timeframe that would result in <= TARGET_CANDLES
  // Iterate from smallest to largest timeframe
  for (const tf of TIMEFRAMES) {
    const estimatedCandles = rangeMs / tf.ms;
    if (estimatedCandles <= TARGET_CANDLES) {
      return tf;
    }
  }

  // Default to largest timeframe for very long ranges
  return TIMEFRAMES[TIMEFRAMES.length - 1];
}

type CandleTuple = [number, number, number, number, number, number];

interface CandlesResult {
  timeframe: string;
  table: string;
  count: number;
  data: CandleTuple[];
}

/**
 * Get the max time available in a table for a ticker
 */
async function getMaxTimeInTable(
  table: string,
  ticker: string
): Promise<number | null> {
  const result = await pool.query(
    `SELECT MAX(time) as max_time FROM ${table} WHERE ticker = $1`,
    [ticker]
  );
  if (!result.rows[0]?.max_time) {
    return null;
  }
  return new Date(result.rows[0].max_time).getTime();
}

/**
 * Query candles from the appropriate table.
 * Falls back to smaller timeframes if the selected one doesn't have recent data.
 */
export async function getCandles(
  startMs: number,
  endMs: number,
  ticker: string
): Promise<CandlesResult> {
  const initialTimeframe = selectTimeframe(startMs, endMs);
  const initialIndex = TIMEFRAMES.findIndex(
    (tf) => tf.id === initialTimeframe.id
  );

  // Try the selected timeframe, then fall back to smaller ones if needed
  // We check if the table has data close to the requested end time
  // "Close" means within 2x the timeframe's duration (e.g., 2 weeks for weekly)
  let timeframe = initialTimeframe;

  for (let i = initialIndex; i >= 0; i--) {
    const tf = TIMEFRAMES[i];
    const maxTime = await getMaxTimeInTable(tf.table, ticker);

    if (maxTime !== null) {
      // Check if this table has recent enough data
      // Allow a gap of up to 2x the timeframe duration from the requested end
      const maxAllowedGap = tf.ms * 2;
      if (endMs - maxTime <= maxAllowedGap) {
        timeframe = tf;
        break;
      }
      // If this is the smallest timeframe (1m), use it regardless of gap
      // because it's our most granular data source
      if (i === 0) {
        timeframe = tf;
        break;
      }
    }
    // Try smaller timeframe
    if (i > 0) {
      timeframe = TIMEFRAMES[i - 1];
    }
  }

  // Convert ms timestamps to ISO for database query
  const startISO = new Date(startMs).toISOString();
  const endISO = new Date(endMs).toISOString();

  const query = `
    SELECT time, open, high, low, close, volume
    FROM ${timeframe.table}
    WHERE time >= $1 AND time <= $2 AND ticker = $3
    ORDER BY time ASC
  `;
  const params = [startISO, endISO, ticker];

  const result = await pool.query(query, params);

  // Convert to Highcharts format: [timestamp_ms, open, high, low, close, volume]
  const candles: CandleTuple[] = result.rows.map((row) => [
    new Date(row.time).getTime(), // ISO → Unix ms
    parseFloat(row.open),
    parseFloat(row.high),
    parseFloat(row.low),
    parseFloat(row.close),
    parseFloat(row.volume),
  ]);

  return {
    timeframe: timeframe.id,
    table: timeframe.table,
    count: candles.length,
    data: candles,
  };
}

interface DateRange {
  start: number;
  end: number;
}

/**
 * Get the date range available for a ticker
 * Queries the candles_1m base table (written at 1-second resolution)
 */
export async function getDateRange(ticker: string): Promise<DateRange | null> {
  const result = await pool.query(
    `
    SELECT MIN(time) as min_time, MAX(time) as max_time
    FROM candles_1m
    WHERE ticker = $1
  `,
    [ticker]
  );

  if (!result.rows[0]?.min_time) {
    return null;
  }

  return {
    start: new Date(result.rows[0].min_time).getTime(),
    end: new Date(result.rows[0].max_time).getTime(),
  };
}
