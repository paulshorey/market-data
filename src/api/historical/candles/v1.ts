import { Request, Response } from "express";
import { getCandles } from "../../../lib/candles.js";

// Default date range: 2010-01-01 to now
const DEFAULT_START_MS = new Date("2010-01-01").getTime();

/**
 * Historical Candles
 *
 * Query params:
 *   ticker - Ticker symbol (required)
 *   start  - Start timestamp in ms (default: 2010-01-01)
 *   end    - End timestamp in ms (default: now)
 *
 * Returns array of tuples: [timestamp_ms, open, high, low, close, volume]
 * Automatically selects the best timeframe based on date range.
 */
export async function candlesHandler(req: Request, res: Response): Promise<void> {
  try {
    const { start, end, ticker } = req.query;

    if (!ticker || typeof ticker !== "string") {
      res.status(400).json({ error: "Missing required param: ticker" });
      return;
    }

    // Use defaults if not provided
    const startMs = start ? parseInt(start as string, 10) : DEFAULT_START_MS;
    const endMs = end ? parseInt(end as string, 10) : Date.now();

    if (isNaN(startMs) || isNaN(endMs)) {
      res.status(400).json({
        error: "Invalid timestamps: start and end must be numbers (ms)",
      });
      return;
    }

    if (startMs >= endMs) {
      res.status(400).json({
        error: "Invalid range: start must be less than end",
      });
      return;
    }

    const result = await getCandles(startMs, endMs, ticker);

    // Return just the data array for Highcharts compatibility
    // Include metadata in headers for debugging
    res.set("X-Timeframe", result.timeframe);
    res.set("X-Table", result.table);
    res.set("X-Count", result.count.toString());

    res.json(result.data);
  } catch (error) {
    console.error("Error fetching candles:", error);
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({
      error: "Failed to fetch candle data",
      message,
    });
  }
}
