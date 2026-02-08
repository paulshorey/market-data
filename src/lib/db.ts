import { Pool } from "pg";

export const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Log which database URL is being used (without password)
const dbUrl = process.env.POSTGRES_URL || "";
const safeDbUrl = dbUrl.replace(/:[^:@]+@/, ":***@");
console.log(`Database URL: ${safeDbUrl}`);
