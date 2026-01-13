import "dotenv/config";
import express, { Request, Response } from "express";
import cors from "cors";
import { pool } from "./lib/db.js";
import { getSchema } from "./lib/schema.js";
import { getCandles, getDateRange } from "./lib/candles.js";

const app = express();
const port = Number(process.env.PORT) || 8080;

app.use(cors());
app.use(express.json());

// Default date range: 2010-01-01 to now
const DEFAULT_START_MS = new Date("2010-01-01").getTime();

/**
 * Health Check
 */
app.get("/health", async (_req: Request, res: Response) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      database: "connected",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Health check failed:", message);
    res.status(503).json({
      status: "unhealthy",
      timestamp: new Date().toISOString(),
      database: "disconnected",
      error: message,
    });
  }
});

/**
 * Database Schema
 */
app.get("/tables", async (_req: Request, res: Response) => {
  try {
    const schema = await getSchema();
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      environment: process.env.RAILWAY_ENVIRONMENT_NAME || "local",
      database: schema,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error fetching schema:", message);
    res.status(500).json({
      success: false,
      error: "Failed to fetch database schema",
      message,
    });
  }
});

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
app.get("/historical/candles", async (req: Request, res: Response) => {
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
});

/**
 * Historical Candles - Date Range
 * Returns the available date range for a ticker
 */
app.get("/historical/range", async (req: Request, res: Response) => {
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
});

/**
 * Start Server
 */
app.listen(port, "::", () => {
  console.log(`🚀 Market Data API server running on port ${port}`);
  console.log(`   Environment: ${process.env.RAILWAY_ENVIRONMENT_NAME || "local"}`);
  console.log(`   Health: http://localhost:${port}/health`);
  console.log(`   Schema: http://localhost:${port}/tables`);
  console.log(`   Candles: http://localhost:${port}/historical/candles?start=...&end=...`);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, shutting down gracefully...");
  await pool.end();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("SIGINT received, shutting down gracefully...");
  await pool.end();
  process.exit(0);
});
