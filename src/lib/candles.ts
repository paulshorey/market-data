import { pool } from "./db.js";

interface Timeframe {
  id: string;
  table: string;
  ms: number;
}

/**
 * Timeframe configurations
 * Note: "candles-1m" uses dash, others use underscore
 */
export const TIMEFRAMES: Timeframe[] = [
  { id: "1m", table: "candles-1m", ms: 60 * 1000 },
  { id: "1h", table: "candles_1h", ms: 60 * 60 * 1000 },
  { id: "1d", table: "candles_1d", ms: 24 * 60 * 60 * 1000 },
  { id: "1w", table: "candles_1w", ms: 7 * 24 * 60 * 60 * 1000 },
];

// Target number of candles to return (aim for good chart density)
export const TARGET_CANDLES = 400;

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
 * Query candles from the appropriate table
 */
export async function getCandles(
  startMs: number,
  endMs: number,
  ticker: string
): Promise<CandlesResult> {
  const timeframe = selectTimeframe(startMs, endMs);

  // Convert ms timestamps to ISO for database query
  const startISO = new Date(startMs).toISOString();
  const endISO = new Date(endMs).toISOString();

  // Build query - table name uses double quotes due to dash in "candles-1m"
  const query = `
    SELECT time, open, high, low, close, volume
    FROM "${timeframe.table}"
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
 */
export async function getDateRange(ticker: string): Promise<DateRange | null> {
  // Query the 1h table for range (good balance of speed/accuracy)
  const result = await pool.query(
    `
    SELECT MIN(time) as min_time, MAX(time) as max_time
    FROM "candles_1h"
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
