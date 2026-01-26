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
  { id: "3m", table: "candles_3m", ms: 3 * 60 * 1000 },
  { id: "7m", table: "candles_7m", ms: 7 * 60 * 1000 },
  { id: "19m", table: "candles_19m", ms: 19 * 60 * 1000 },
  { id: "29m", table: "candles_29m", ms: 29 * 60 * 1000 },
  { id: "59m", table: "candles_59m", ms: 59 * 60 * 1000 },
  { id: "109m", table: "candles_109m", ms: 109 * 60 * 1000 },
  { id: "181m", table: "candles_181m", ms: 181 * 60 * 1000 },
  { id: "1d", table: "candles_1d", ms: 24 * 60 * 60 * 1000 },
  { id: "1w", table: "candles_1w", ms: 7 * 24 * 60 * 60 * 1000 },
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
    `SELECT MAX(time) as max_time FROM "${table}" WHERE ticker = $1`,
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
 * Queries the 1-minute table as it has the most recent data
 */
export async function getDateRange(ticker: string): Promise<DateRange | null> {
  // Query the 1m table for range (most granular, has latest data)
  const result = await pool.query(
    `
    SELECT MIN(time) as min_time, MAX(time) as max_time
    FROM "candles-1m"
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
