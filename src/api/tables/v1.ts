import { Request, Response } from "express";
import { getSchema } from "./schema.js";

/**
 * Database Schema
 */
export async function tablesHandler(_req: Request, res: Response): Promise<void> {
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
}
