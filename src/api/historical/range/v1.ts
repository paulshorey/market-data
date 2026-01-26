import { Request, Response } from "express";
import { getDateRange } from "../../../lib/candles.js";

/**
 * Historical Candles - Date Range
 * Returns the available date range for a ticker
 */
export async function rangeHandler(req: Request, res: Response): Promise<void> {
  try {
    const { ticker } = req.query;

    if (!ticker || typeof ticker !== "string") {
      res.status(400).json({ error: "Missing required param: ticker" });
      return;
    }

    const range = await getDateRange(ticker);

    if (!range) {
      res.status(404).json({ error: "No data available for ticker" });
      return;
    }

    res.json(range);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error fetching date range:", message);
    res.status(500).json({
      error: "Failed to fetch date range",
      message,
    });
  }
}
