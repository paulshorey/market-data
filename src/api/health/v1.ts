import { Request, Response } from "express";
import { pool } from "../../lib/db.js";
import { getStreamStatus } from "../../stream/tbbo-stream.js";

/**
 * Health Check
 */
export async function healthHandler(_req: Request, res: Response): Promise<void> {
  try {
    await pool.query("SELECT 1");
    const streamStatus = getStreamStatus();

    res.status(200).json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      database: "connected",
      stream: streamStatus,
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
}
