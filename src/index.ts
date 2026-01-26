import "dotenv/config";
import express from "express";
import cors from "cors";
import { pool } from "./lib/db.js";
import { startDatabentoStream, stopDatabentoStream } from "./stream/tbbo-stream.js";

// API route handlers
import { healthHandler } from "./api/health/v1.js";
import { tablesHandler } from "./api/tables/v1.js";
import { candlesHandler } from "./api/historical/candles/v1.js";
import { rangeHandler } from "./api/historical/range/v1.js";

const app = express();
const port = Number(process.env.PORT) || 8080;

app.use(cors());
app.use(express.json());

// Routes
app.get("/health", healthHandler);
app.get("/tables", tablesHandler);
app.get("/historical/candles", candlesHandler);
app.get("/historical/range", rangeHandler);

/**
 * Start Server
 */
app.listen(port, "::", async () => {
  console.log(`🚀 Market Data API server running on port ${port}`);
  console.log(`   Environment: ${process.env.RAILWAY_ENVIRONMENT_NAME || "local"}`);
  console.log(`   Health: http://localhost:${port}/health`);
  console.log(`   Schema: http://localhost:${port}/tables`);
  console.log(`   Candles: http://localhost:${port}/historical/candles?start=...&end=...`);

  // Start the Databento live stream after API server is ready
  // This loads CVD from database before processing any trades
  await startDatabentoStream();
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, shutting down gracefully...");
  stopDatabentoStream(); // Stop stream and flush pending candles
  await pool.end();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("SIGINT received, shutting down gracefully...");
  stopDatabentoStream(); // Stop stream and flush pending candles
  await pool.end();
  process.exit(0);
});
