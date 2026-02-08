#!/usr/bin/env npx tsx
/**
 * Migrate from Timescale DB to regular PostgreSQL
 *
 * Copies all tables and data from the Timescale (source) database to a plain
 * Postgres (target) database, creating each table with PRIMARY KEY (time, ticker).
 *
 * Usage:
 *   DATABASE_URL=postgresql://... POSTGRES_URL=postgresql://... npx tsx scripts/migrate-timescale-to-postgres.ts
 *
 * Options:
 *   --dry-run  Print DDL and row counts only; do not create tables or copy data.
 */

import "dotenv/config";
import { Pool } from "pg";

const DRY_RUN = process.argv.includes("--dry-run");
/** Rows per SELECT from source */
const FETCH_BATCH = 5000;
/** Rows per INSERT into target (keeps param count under PostgreSQL limit) */
const INSERT_BATCH = 500;

const DATABASE_URL = process.env.DATABASE_URL;
const POSTGRES_URL = process.env.POSTGRES_URL;

if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL (source Timescale DB connection string)");
  process.exit(1);
}
if (!POSTGRES_URL) {
  console.error("Missing POSTGRES_URL (target Postgres connection string)");
  process.exit(1);
}

const sourcePool = new Pool({
  connectionString: DATABASE_URL,
  max: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

const targetPool = new Pool({
  connectionString: POSTGRES_URL,
  max: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

interface ColumnMeta {
  name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  character_maximum_length: number | null;
}

/** Map information_schema data_type to PostgreSQL column definition */
function toPgType(col: ColumnMeta): string {
  const t = col.data_type;
  if (t === "timestamp with time zone") return "TIMESTAMPTZ";
  if (t === "double precision") return "DOUBLE PRECISION";
  if (t === "numeric") return "NUMERIC";
  if (t === "integer") return "INTEGER";
  if (t === "bigint") return "BIGINT";
  if (t === "smallint") return "SMALLINT";
  if (t === "text") return "TEXT";
  return t.toUpperCase();
}

async function getSourceTables(): Promise<string[]> {
  const r = await sourcePool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  return r.rows.map((row) => row.table_name as string);
}

async function getSourceColumns(tableName: string): Promise<ColumnMeta[]> {
  const r = await sourcePool.query(
    `
    SELECT column_name, data_type, is_nullable, column_default, character_maximum_length
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `,
    [tableName],
  );
  return r.rows as ColumnMeta[];
}

function buildCreateTable(tableName: string, columns: ColumnMeta[]): string {
  const hasTime = columns.some((c) => c.name === "time");
  const hasTicker = columns.some((c) => c.name === "ticker");
  if (!hasTime || !hasTicker) {
    throw new Error(`Table "${tableName}" must have columns "time" and "ticker" for primary key. Found: ${columns.map((c) => c.name).join(", ")}`);
  }

  const parts = columns.map((col) => {
    const pgType = toPgType(col);
    const nullable = col.is_nullable === "YES" ? "" : " NOT NULL";
    return `  "${col.name}" ${pgType}${nullable}`;
  });
  parts.push("  PRIMARY KEY (time, ticker)");
  return `CREATE TABLE IF NOT EXISTS "${tableName}" (\n${parts.join(",\n")}\n);`;
}

async function getRowCount(pool: Pool, tableName: string): Promise<number> {
  const r = await pool.query(`SELECT COUNT(*)::bigint AS n FROM "${tableName}"`);
  return Number(r.rows[0].n);
}

async function copyTable(tableName: string, columns: ColumnMeta[]): Promise<void> {
  const colList = columns.map((c) => `"${c.name}"`).join(", ");
  const count = await getRowCount(sourcePool, tableName);
  console.log(`  Rows to copy: ${count}`);

  if (count === 0) return;

  let offset = 0;
  let totalInserted = 0;
  const numCols = columns.length;
  while (offset < count) {
    const r = await sourcePool.query({
      text: `SELECT ${colList} FROM "${tableName}" ORDER BY time, ticker LIMIT $1 OFFSET $2`,
      values: [FETCH_BATCH, offset],
    });
    if (r.rows.length === 0) break;

    for (let i = 0; i < r.rows.length; i += INSERT_BATCH) {
      const chunk = r.rows.slice(i, i + INSERT_BATCH);
      const placeholders = chunk.map((_, ii) => "(" + Array.from({ length: numCols }, (_, j) => `$${ii * numCols + j + 1}`).join(", ") + ")");
      const flat = chunk.flatMap((row) => columns.map((col) => row[col.name]));
      const query = `INSERT INTO "${tableName}" (${colList}) VALUES ${placeholders.join(", ")} ON CONFLICT (time, ticker) DO NOTHING`;
      await targetPool.query({ text: query, values: flat });
      totalInserted += chunk.length;
    }
    offset += FETCH_BATCH;
    process.stdout.write(`  Copied ${Math.min(offset, count)} / ${count}\r`);
  }
  console.log(`  Copied ${totalInserted} rows.`);
}

async function main(): Promise<void> {
  console.log("Migration: Timescale DB → PostgreSQL");
  console.log("Dry run:", DRY_RUN);
  if (DRY_RUN) {
    console.log("(No tables will be created and no data will be copied.)");
  }
  console.log("");

  const tables = await getSourceTables();
  console.log(`Tables on source: ${tables.join(", ")}`);

  for (const tableName of tables) {
    console.log(`\n--- ${tableName} ---`);
    const columns = await getSourceColumns(tableName);
    const ddl = buildCreateTable(tableName, columns);
    console.log("DDL:");
    console.log(ddl);
    const count = await getRowCount(sourcePool, tableName);
    console.log(`Source row count: ${count}`);

    if (!DRY_RUN) {
      await targetPool.query(ddl);
      console.log("  Table created on target.");
      await copyTable(tableName, columns);
    }
  }

  await sourcePool.end();
  await targetPool.end();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
