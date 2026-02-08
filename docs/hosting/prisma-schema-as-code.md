## Prisma Setup

### Installation

```bash
# Install Prisma CLI and client
npm install prisma --save-dev
npm install @prisma/client

# Initialize Prisma (creates prisma/ directory with schema.prisma)
npx prisma init
```

### Project Structure

```
project/
├── prisma/
│   ├── schema.prisma          # Main schema definition
│   ├── migrations/            # Migration history (auto-generated)
│   └── seed.ts                # Optional seed data
├── scripts/
│   ├── import-custom-ohlcv.ts
│   ├── calculate-rsi.ts
│   └── db-advanced-setup.ts   # For partitions, indexes not in Prisma
├── src/
│   └── lib/
│       └── prisma.ts          # Prisma client singleton
├── docs/
│   ├── PRISMA_SKILL.md        # AI agent skill file
│   └── ADVANCED_POSTGRES.md   # Advanced DB documentation
├── .env                       # Database connection string
├── package.json
└── tsconfig.json
```

---

### Configuration Files

**.env**

```env
DATABASE_URL="postgresql://postgres:password@localhost:5432/trading?schema=public"
```

**prisma/schema.prisma**

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["multiSchema"]
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// =============================================================================
// Base 1-Minute OHLCV Table
// =============================================================================

model OhlcvBase1m {
  timestamp               DateTime @db.Timestamptz()
  symbol                  String   @db.VarChar(20)
  minuteIndex             Int      @map("minute_index") @db.SmallInt

  open                    Float
  high                    Float
  low                     Float
  close                   Float
  volume                  Float

  tradeCount              Int?     @map("trade_count")
  vwap                    Float?

  // Indicators (not indexed, for HOT updates)
  rsi14                   Float?   @map("rsi_14")
  atr14                   Float?   @map("atr_14")
  cvd                     Float?

  minutesIntoSession      Int?     @map("minutes_into_session") @db.SmallInt
  windowMinutes           Int      @default(1) @map("window_minutes") @db.SmallInt
  windowSpansSessions     Boolean  @default(false) @map("window_spans_sessions")

  isRegularSession        Boolean  @default(true) @map("is_regular_session")
  hasGapFromPriorSession  Boolean  @default(false) @map("has_gap_from_prior_session")

  @@id([symbol, timestamp])
  @@index([symbol, minuteIndex, timestamp], name: "idx_ohlcv_1m_lookup")
  @@index([symbol, timestamp], name: "idx_ohlcv_1m_symbol_time")
  @@map("ohlcv_1m")
}

// =============================================================================
// 5-Minute Rolling Window Table
// =============================================================================

model Ohlcv5m {
  timestamp               DateTime @db.Timestamptz()
  symbol                  String   @db.VarChar(20)
  minuteIndex             Int      @map("minute_index") @db.SmallInt

  open                    Float
  high                    Float
  low                     Float
  close                   Float
  volume                  Float

  tradeCount              Int?     @map("trade_count")
  vwap                    Float?

  rsi14                   Float?   @map("rsi_14")
  atr14                   Float?   @map("atr_14")
  cvd                     Float?

  minutesIntoSession      Int?     @map("minutes_into_session") @db.SmallInt
  windowMinutes           Int      @default(5) @map("window_minutes") @db.SmallInt
  windowSpansSessions     Boolean  @default(false) @map("window_spans_sessions")

  isRegularSession        Boolean  @default(true) @map("is_regular_session")
  hasGapFromPriorSession  Boolean  @default(false) @map("has_gap_from_prior_session")

  @@id([symbol, timestamp])
  @@index([symbol, minuteIndex, timestamp], name: "idx_ohlcv_5m_lookup")
  @@index([symbol, timestamp], name: "idx_ohlcv_5m_symbol_time")
  @@map("ohlcv_5m")
}

// =============================================================================
// 13-Minute Rolling Window Table (Example Custom Timeframe)
// =============================================================================

model Ohlcv13m {
  timestamp               DateTime @db.Timestamptz()
  symbol                  String   @db.VarChar(20)
  minuteIndex             Int      @map("minute_index") @db.SmallInt

  open                    Float
  high                    Float
  low                     Float
  close                   Float
  volume                  Float

  tradeCount              Int?     @map("trade_count")
  vwap                    Float?

  rsi14                   Float?   @map("rsi_14")
  atr14                   Float?   @map("atr_14")
  cvd                     Float?

  minutesIntoSession      Int?     @map("minutes_into_session") @db.SmallInt
  windowMinutes           Int      @default(13) @map("window_minutes") @db.SmallInt
  windowSpansSessions     Boolean  @default(false) @map("window_spans_sessions")

  isRegularSession        Boolean  @default(true) @map("is_regular_session")
  hasGapFromPriorSession  Boolean  @default(false) @map("has_gap_from_prior_session")

  @@id([symbol, timestamp])
  @@index([symbol, minuteIndex, timestamp], name: "idx_ohlcv_13m_lookup")
  @@index([symbol, timestamp], name: "idx_ohlcv_13m_symbol_time")
  @@map("ohlcv_13m")
}

// =============================================================================
// 60-Minute Rolling Window Table
// =============================================================================

model Ohlcv60m {
  timestamp               DateTime @db.Timestamptz()
  symbol                  String   @db.VarChar(20)
  minuteIndex             Int      @map("minute_index") @db.SmallInt

  open                    Float
  high                    Float
  low                     Float
  close                   Float
  volume                  Float

  tradeCount              Int?     @map("trade_count")
  vwap                    Float?

  rsi14                   Float?   @map("rsi_14")
  atr14                   Float?   @map("atr_14")
  cvd                     Float?

  minutesIntoSession      Int?     @map("minutes_into_session") @db.SmallInt
  windowMinutes           Int      @default(60) @map("window_minutes") @db.SmallInt
  windowSpansSessions     Boolean  @default(false) @map("window_spans_sessions")

  isRegularSession        Boolean  @default(true) @map("is_regular_session")
  hasGapFromPriorSession  Boolean  @default(false) @map("has_gap_from_prior_session")

  @@id([symbol, timestamp])
  @@index([symbol, minuteIndex, timestamp], name: "idx_ohlcv_60m_lookup")
  @@index([symbol, timestamp], name: "idx_ohlcv_60m_symbol_time")
  @@map("ohlcv_60m")
}

// =============================================================================
// 181-Minute Rolling Window Table (Example Custom Timeframe)
// =============================================================================

model Ohlcv181m {
  timestamp               DateTime @db.Timestamptz()
  symbol                  String   @db.VarChar(20)
  minuteIndex             Int      @map("minute_index") @db.SmallInt

  open                    Float
  high                    Float
  low                     Float
  close                   Float
  volume                  Float

  tradeCount              Int?     @map("trade_count")
  vwap                    Float?

  rsi14                   Float?   @map("rsi_14")
  atr14                   Float?   @map("atr_14")
  cvd                     Float?

  minutesIntoSession      Int?     @map("minutes_into_session") @db.SmallInt
  windowMinutes           Int      @default(181) @map("window_minutes") @db.SmallInt
  windowSpansSessions     Boolean  @default(false) @map("window_spans_sessions")

  isRegularSession        Boolean  @default(true) @map("is_regular_session")
  hasGapFromPriorSession  Boolean  @default(false) @map("has_gap_from_prior_session")

  @@id([symbol, timestamp])
  @@index([symbol, minuteIndex, timestamp], name: "idx_ohlcv_181m_lookup")
  @@index([symbol, timestamp], name: "idx_ohlcv_181m_symbol_time")
  @@map("ohlcv_181m")
}

// =============================================================================
// Symbol Metadata
// =============================================================================

model Symbol {
  symbol              String   @id @db.VarChar(20)
  name                String?
  exchange            String?  @db.VarChar(20)
  assetClass          String?  @map("asset_class") @db.VarChar(20)
  tickSize            Float?   @map("tick_size")
  lotSize             Float?   @map("lot_size")
  sessionStartTime    String?  @map("session_start_time") @db.VarChar(10)
  sessionEndTime      String?  @map("session_end_time") @db.VarChar(10)
  timezone            String?  @db.VarChar(50)
  firstAvailableDate  DateTime? @map("first_available_date") @db.Date
  lastAvailableDate   DateTime? @map("last_available_date") @db.Date
  isActive            Boolean  @default(true) @map("is_active")

  @@map("symbols")
}

// =============================================================================
// Trading Sessions Calendar
// =============================================================================

model TradingSession {
  sessionDate    DateTime @map("session_date") @db.Date
  exchange       String   @db.VarChar(20)
  sessionStart   DateTime @map("session_start") @db.Timestamptz()
  sessionEnd     DateTime @map("session_end") @db.Timestamptz()
  totalMinutes   Int      @map("total_minutes") @db.SmallInt
  isHalfDay      Boolean  @default(false) @map("is_half_day")
  isHoliday      Boolean  @default(false) @map("is_holiday")
  notes          String?

  @@id([exchange, sessionDate])
  @@map("trading_sessions")
}

// =============================================================================
// Session Gaps (for gap analysis)
// =============================================================================

model SessionGap {
  sessionDate   DateTime @map("session_date") @db.Date
  symbol        String   @db.VarChar(20)
  priorClose    Float    @map("prior_close")
  currentOpen   Float    @map("current_open")
  gapAmount     Float    @map("gap_amount")
  gapPercent    Float    @map("gap_percent")
  gapDirection  String   @map("gap_direction") @db.VarChar(10)

  @@id([symbol, sessionDate])
  @@map("session_gaps")
}
```

**src/lib/prisma.ts** (Singleton client)

```typescript
import { PrismaClient } from "@prisma/client";

declare global {
  var prisma: PrismaClient | undefined;
}

export const prisma =
  global.prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  global.prisma = prisma;
}

export default prisma;
```

---

### Prisma Commands

```bash
# Pull existing database schema into Prisma
npx prisma db pull

# Generate Prisma Client after schema changes
npx prisma generate

# Create and apply migration
npx prisma migrate dev --name add_new_indicator

# Apply migrations in production
npx prisma migrate deploy

# Reset database (DANGEROUS - drops all data)
npx prisma migrate reset

# Open Prisma Studio (GUI for browsing data)
npx prisma studio

# Format schema file
npx prisma format

# Validate schema
npx prisma validate
```

---

## AI Agent Skill File

**docs/PRISMA_SKILL.md**

```markdown
# Prisma ORM Skill File

## Overview

This project uses Prisma ORM to manage the PostgreSQL database schema for a financial time-series backtesting platform. The database stores OHLCV (Open, High, Low, Close, Volume) data at multiple timeframes with rolling window sampling.

## Project Context

- **Database**: PostgreSQL with composite partitioning (LIST by symbol → RANGE by month)
- **Primary tables**: `ohlcv_1m`, `ohlcv_5m`, `ohlcv_13m`, `ohlcv_60m`, `ohlcv_181m`, etc.
- **Schema location**: `prisma/schema.prisma`
- **Advanced SQL**: `scripts/db-advanced-setup.ts` (partitions, custom indexes)

## Key Concepts

### Rolling Window Sampling

Unlike traditional OHLCV bars that align to calendar boundaries, this system uses rolling windows:

- Every minute produces a new row, even for higher timeframes
- A 60-minute row at 10:45 contains data from 9:45 to 10:45
- `minute_index` cycles 0 to N-1, identifying which "phase" of the timeframe

### Table Naming Convention
```

ohlcv\_{interval}m

````

Examples: `ohlcv_1m`, `ohlcv_5m`, `ohlcv_13m`, `ohlcv_60m`, `ohlcv_181m`

### Column Conventions

| Column | Type | Description |
|--------|------|-------------|
| `timestamp` | TIMESTAMPTZ | Row timestamp (end of rolling window) |
| `symbol` | VARCHAR(20) | Ticker symbol (e.g., 'ES', 'NQ') |
| `minute_index` | SMALLINT | Cycles 0 to interval-1 |
| `open/high/low/close` | FLOAT | OHLC prices |
| `volume` | FLOAT | Aggregated volume |
| `rsi_14`, `atr_14`, etc. | FLOAT | Indicator columns (nullable) |

## Common Tasks

### Adding a New Indicator Column

1. Edit `prisma/schema.prisma`:
```prisma
model Ohlcv60m {
  // ... existing fields ...

  // Add new indicator
  ema20    Float?   @map("ema_20")
  ema50    Float?   @map("ema_50")
  macd     Float?
  macdSignal Float? @map("macd_signal")
  macdHist   Float? @map("macd_hist")
}
````

2. Create and apply migration:

```bash
npx prisma migrate dev --name add_macd_indicators
```

3. Regenerate client:

```bash
npx prisma generate
```

4. IMPORTANT: Repeat for ALL timeframe tables that need the indicator.

### Adding a New Timeframe Table

1. Copy an existing model in `prisma/schema.prisma`:

```prisma
model Ohlcv240m {
  timestamp               DateTime @db.Timestamptz()
  symbol                  String   @db.VarChar(20)
  minuteIndex             Int      @map("minute_index") @db.SmallInt

  open                    Float
  high                    Float
  low                     Float
  close                   Float
  volume                  Float

  tradeCount              Int?     @map("trade_count")
  vwap                    Float?

  rsi14                   Float?   @map("rsi_14")
  atr14                   Float?   @map("atr_14")
  cvd                     Float?

  minutesIntoSession      Int?     @map("minutes_into_session") @db.SmallInt
  windowMinutes           Int      @default(240) @map("window_minutes") @db.SmallInt
  windowSpansSessions     Boolean  @default(false) @map("window_spans_sessions")

  isRegularSession        Boolean  @default(true) @map("is_regular_session")
  hasGapFromPriorSession  Boolean  @default(false) @map("has_gap_from_prior_session")

  @@id([symbol, timestamp])
  @@index([symbol, minuteIndex, timestamp], name: "idx_ohlcv_240m_lookup")
  @@index([symbol, timestamp], name: "idx_ohlcv_240m_symbol_time")
  @@map("ohlcv_240m")
}
```

2. Apply migration:

```bash
npx prisma migrate dev --name add_ohlcv_240m_table
```

3. IMPORTANT: Run advanced setup script for partitioning:

```bash
npx ts-node scripts/db-advanced-setup.ts setup-partitions ohlcv_240m
```

### Removing an Indicator Column

1. Edit `prisma/schema.prisma` to remove the field
2. Create migration:

```bash
npx prisma migrate dev --name remove_unused_indicator
```

**WARNING**: This permanently deletes data in that column!

### Renaming a Column

1. Use raw SQL in migration to preserve data:

```sql
-- In prisma/migrations/YYYYMMDDHHMMSS_rename_column/migration.sql
ALTER TABLE ohlcv_60m RENAME COLUMN old_name TO new_name;
```

2. Update `schema.prisma` to match new name
3. Run `npx prisma generate`

## Querying with Prisma Client

### Basic Query

```typescript
import prisma from "@/lib/prisma";

// Get last 100 rows for ES
const data = await prisma.ohlcv60m.findMany({
  where: {
    symbol: "ES",
  },
  orderBy: {
    timestamp: "desc",
  },
  take: 100,
});
```

### Query by Minute Index (for indicator sampling)

```typescript
// Get last 14 periods for RSI calculation
const samples = await prisma.ohlcv60m.findMany({
  where: {
    symbol: "ES",
    minuteIndex: 45,
    timestamp: {
      lte: new Date("2024-03-15T10:45:00Z"),
    },
  },
  orderBy: {
    timestamp: "desc",
  },
  take: 14,
  select: {
    timestamp: true,
    close: true,
  },
});
```

### Date Range Query

```typescript
const data = await prisma.ohlcv60m.findMany({
  where: {
    symbol: "ES",
    timestamp: {
      gte: new Date("2024-01-01"),
      lt: new Date("2024-02-01"),
    },
  },
  orderBy: {
    timestamp: "asc",
  },
});
```

### Update Indicator Values

```typescript
// Update single row
await prisma.ohlcv60m.update({
  where: {
    symbol_timestamp: {
      symbol: "ES",
      timestamp: new Date("2024-03-15T10:45:00Z"),
    },
  },
  data: {
    rsi14: 65.5,
    atr14: 12.3,
  },
});
```

### Bulk Updates (Use Raw SQL for Performance)

For bulk indicator updates, DO NOT use Prisma's updateMany in a loop. Instead, use the staging table pattern with raw SQL:

```typescript
import prisma from "@/lib/prisma";

// Use raw SQL for bulk updates
await prisma.$executeRaw`
  CREATE TEMP TABLE staging_indicators (
    timestamp TIMESTAMPTZ NOT NULL,
    symbol VARCHAR(20) NOT NULL,
    rsi_14 DOUBLE PRECISION
  ) ON COMMIT DROP
`;

// ... COPY data to staging table ...

await prisma.$executeRaw`
  UPDATE ohlcv_60m m
  SET rsi_14 = s.rsi_14
  FROM staging_indicators s
  WHERE m.symbol = s.symbol AND m.timestamp = s.timestamp
`;
```

See `scripts/calculate-rsi.ts` for the full bulk update pattern.

## Limitations - What Prisma CANNOT Do

Prisma does not support these PostgreSQL features. They must be managed separately:

1. **Composite partitioning** (LIST → RANGE)
2. **Fillfactor settings** for HOT updates
3. **Autovacuum configuration**
4. **COPY command** for bulk inserts
5. **Staging table bulk updates**
6. **Partial indexes**
7. **Skip indexes**

See `docs/ADVANCED_POSTGRES.md` for managing these features.

## Migration Workflow

### Development

```bash
# Make schema changes in schema.prisma
# Then create migration:
npx prisma migrate dev --name descriptive_name

# This will:
# 1. Generate migration SQL
# 2. Apply to dev database
# 3. Regenerate Prisma Client
```

### Production

```bash
# Apply pending migrations
npx prisma migrate deploy
```

### Introspection (Pull from existing DB)

If changes were made directly to the database:

```bash
npx prisma db pull
npx prisma generate
```

## Files Reference

| File                             | Purpose                             |
| -------------------------------- | ----------------------------------- |
| `prisma/schema.prisma`           | Schema definition (source of truth) |
| `prisma/migrations/`             | Migration history                   |
| `src/lib/prisma.ts`              | Client singleton                    |
| `scripts/db-advanced-setup.ts`   | Partitioning, advanced indexes      |
| `scripts/import-custom-ohlcv.ts` | Data import with partitions         |
| `scripts/calculate-rsi.ts`       | Bulk indicator updates              |
| `docs/ADVANCED_POSTGRES.md`      | Advanced DB documentation           |

## Common Errors

### "Migration failed: relation already exists"

The table was created outside Prisma. Options:

1. Mark migration as applied: `npx prisma migrate resolve --applied MIGRATION_NAME`
2. Or drop and recreate via Prisma

### "Column does not exist"

Run `npx prisma generate` after schema changes.

### Type mismatch errors

Check that `@map()` column names match the actual database columns exactly.

## Best Practices

1. **Always use `@map()`** to keep Prisma camelCase while database uses snake_case
2. **Add indicators to ALL timeframe tables** to keep schemas consistent
3. **Run advanced setup script** after creating new tables for partitioning
4. **Use raw SQL for bulk operations** - Prisma is slow for mass updates
5. **Keep migrations small and focused** - one logical change per migration
6. **Never edit applied migrations** - create new ones instead
7. **Test migrations on dev** before applying to production

````

---

## Advanced PostgreSQL Documentation

**docs/ADVANCED_POSTGRES.md**
```markdown
# Advanced PostgreSQL Configuration

This document covers PostgreSQL optimizations that Prisma cannot manage. These must be applied manually or via the `scripts/db-advanced-setup.ts` script.

## Overview

The OHLCV tables use advanced PostgreSQL features for performance:

| Feature | Purpose | Prisma Support |
|---------|---------|----------------|
| Composite partitioning | Query performance, data management | ❌ None |
| Fillfactor | HOT updates for indicators | ❌ None |
| Autovacuum tuning | Update-heavy workload | ❌ None |
| COPY bulk inserts | Fast data loading | ❌ None |
| Staging table updates | Fast bulk indicator updates | ❌ None |

## Table Architecture

### Partition Hierarchy

````

ohlcv_60m (parent - partitioned by LIST on symbol)
├── ohlcv_60m_es (symbol partition - partitioned by RANGE on timestamp)
│ ├── ohlcv_60m_es_2014_01 (leaf partition)
│ ├── ohlcv_60m_es_2014_02
│ ├── ...
│ └── ohlcv_60m_es_2026_12
├── ohlcv_60m_nq
│ ├── ohlcv_60m_nq_2014_01
│ └── ...
└── ohlcv_60m_cl
└── ...

````

### Why This Structure?

1. **LIST by symbol first**: Queries always filter by symbol. This immediately eliminates ~95% of data.
2. **RANGE by timestamp second**: Date range queries scan only relevant months.
3. **Monthly partitions**: Balances partition count vs. partition size.

## Setup Scripts

### Initial Table Setup (After Prisma Migration)

When Prisma creates a new table, it creates a simple unpartitioned table. You must:

1. Let Prisma create the base schema (columns, basic indexes)
2. Run the advanced setup script to convert to partitioned structure

```bash
# After: npx prisma migrate dev --name add_ohlcv_240m

# Run advanced setup
npx ts-node scripts/db-advanced-setup.ts convert-to-partitioned ohlcv_240m

# Or setup partitions for existing partitioned table
npx ts-node scripts/db-advanced-setup.ts setup-partitions ohlcv_240m --symbols ES,NQ,CL
````

### The Advanced Setup Script

```typescript
// scripts/db-advanced-setup.ts

import { Pool } from "pg";

const pool = new Pool({
  host: process.env.PGHOST || "localhost",
  port: parseInt(process.env.PGPORT || "5432", 10),
  database: process.env.PGDATABASE || "trading",
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD || "",
});

// =============================================================================
// Partition Management
// =============================================================================

async function createSymbolPartition(tableName: string, symbol: string): Promise<void> {
  const client = await pool.connect();
  const symbolPartition = `${tableName}_${symbol.toLowerCase()}`;

  try {
    // Check if exists
    const exists = await client.query(
      `
      SELECT 1 FROM pg_class WHERE relname = $1
    `,
      [symbolPartition],
    );

    if (exists.rows.length > 0) {
      console.log(`Symbol partition ${symbolPartition} already exists`);
      return;
    }

    await client.query(`
      CREATE TABLE ${symbolPartition} PARTITION OF ${tableName}
      FOR VALUES IN ('${symbol}')
      PARTITION BY RANGE (timestamp)
      WITH (fillfactor = 70)
    `);

    console.log(`Created symbol partition: ${symbolPartition}`);
  } finally {
    client.release();
  }
}

async function createMonthPartitions(tableName: string, symbol: string, startDate: Date, endDate: Date): Promise<void> {
  const client = await pool.connect();
  const symbolPartition = `${tableName}_${symbol.toLowerCase()}`;

  try {
    let current = new Date(startDate.getFullYear(), startDate.getMonth(), 1);

    while (current < endDate) {
      const year = current.getFullYear();
      const month = current.getMonth() + 1;
      const suffix = `${year}_${String(month).padStart(2, "0")}`;
      const monthPartition = `${symbolPartition}_${suffix}`;

      const nextMonth = new Date(year, month, 1);

      // Check if exists
      const exists = await client.query(
        `
        SELECT 1 FROM pg_class WHERE relname = $1
      `,
        [monthPartition],
      );

      if (exists.rows.length === 0) {
        await client.query(`
          CREATE TABLE ${monthPartition} PARTITION OF ${symbolPartition}
          FOR VALUES FROM ('${current.toISOString()}') TO ('${nextMonth.toISOString()}')
          WITH (fillfactor = 70)
        `);
        console.log(`Created: ${monthPartition}`);
      }

      current = nextMonth;
    }
  } finally {
    client.release();
  }
}

// =============================================================================
// Convert Prisma Table to Partitioned
// =============================================================================

async function convertToPartitioned(tableName: string, interval: number): Promise<void> {
  const client = await pool.connect();
  const tempTable = `${tableName}_old`;

  try {
    await client.query("BEGIN");

    // 1. Rename existing table
    console.log(`Renaming ${tableName} to ${tempTable}...`);
    await client.query(`ALTER TABLE ${tableName} RENAME TO ${tempTable}`);

    // 2. Create new partitioned table
    console.log(`Creating partitioned ${tableName}...`);
    await client.query(`
      CREATE TABLE ${tableName} (
        timestamp TIMESTAMPTZ NOT NULL,
        symbol VARCHAR(20) NOT NULL,
        minute_index SMALLINT NOT NULL,
        
        open DOUBLE PRECISION NOT NULL,
        high DOUBLE PRECISION NOT NULL,
        low DOUBLE PRECISION NOT NULL,
        close DOUBLE PRECISION NOT NULL,
        volume DOUBLE PRECISION NOT NULL,
        
        trade_count INTEGER,
        vwap DOUBLE PRECISION,
        
        rsi_14 DOUBLE PRECISION,
        atr_14 DOUBLE PRECISION,
        cvd DOUBLE PRECISION,
        
        minutes_into_session SMALLINT,
        window_minutes SMALLINT DEFAULT ${interval},
        window_spans_sessions BOOLEAN DEFAULT FALSE,
        
        is_regular_session BOOLEAN DEFAULT TRUE,
        has_gap_from_prior_session BOOLEAN DEFAULT FALSE,
        
        PRIMARY KEY (symbol, timestamp)
      ) PARTITION BY LIST (symbol)
      WITH (fillfactor = 70)
    `);

    // 3. Set autovacuum
    await client.query(`
      ALTER TABLE ${tableName} SET (
        autovacuum_vacuum_scale_factor = 0,
        autovacuum_vacuum_threshold = 500000,
        autovacuum_analyze_scale_factor = 0,
        autovacuum_analyze_threshold = 500000
      )
    `);

    // 4. Create indexes
    await client.query(`
      CREATE INDEX idx_${tableName}_lookup 
      ON ${tableName} (symbol, minute_index, timestamp)
    `);

    await client.query(`
      CREATE INDEX idx_${tableName}_symbol_time
      ON ${tableName} (symbol, timestamp)
    `);

    await client.query("COMMIT");

    console.log(`\nTable ${tableName} converted to partitioned structure.`);
    console.log(`Old data is in ${tempTable}.`);
    console.log(`\nNext steps:`);
    console.log(`1. Create symbol partitions: setup-partitions ${tableName} --symbols ES,NQ,CL`);
    console.log(`2. Migrate data from ${tempTable}`);
    console.log(`3. Drop ${tempTable} when confirmed`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// =============================================================================
// Apply Fillfactor to Existing Tables
// =============================================================================

async function applyFillfactor(tableName: string): Promise<void> {
  const client = await pool.connect();

  try {
    // Get all partitions
    const partitions = await client.query(`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname LIKE '${tableName}%'
        AND n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
    `);

    for (const row of partitions.rows) {
      console.log(`Setting fillfactor=70 on ${row.relname}...`);
      await client.query(`
        ALTER TABLE ${row.relname} SET (fillfactor = 70)
      `);
    }

    console.log(`\nFillfactor set. Run VACUUM FULL to rewrite tables (this takes time and locks tables).`);
  } finally {
    client.release();
  }
}

// =============================================================================
// CLI
// =============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "convert-to-partitioned": {
      const tableName = args[1];
      const interval = parseInt(tableName.match(/\d+/)?.[0] || "60", 10);
      await convertToPartitioned(tableName, interval);
      break;
    }

    case "setup-partitions": {
      const tableName = args[1];
      const symbolsIdx = args.indexOf("--symbols");
      const symbols = symbolsIdx !== -1 ? args[symbolsIdx + 1].split(",") : ["ES"];

      const startDate = new Date("2014-01-01");
      const endDate = new Date("2027-01-01");

      for (const symbol of symbols) {
        await createSymbolPartition(tableName, symbol);
        await createMonthPartitions(tableName, symbol, startDate, endDate);
      }
      break;
    }

    case "apply-fillfactor": {
      const tableName = args[1];
      await applyFillfactor(tableName);
      break;
    }

    default:
      console.log(`
Usage:
  npx ts-node scripts/db-advanced-setup.ts <command> [options]

Commands:
  convert-to-partitioned <table>     Convert Prisma table to partitioned
  setup-partitions <table>           Create symbol and month partitions
    --symbols ES,NQ,CL               Symbols to create partitions for
  apply-fillfactor <table>           Set fillfactor=70 on table and partitions
      `);
  }

  await pool.end();
}

main().catch(console.error);
```

## HOT Updates

### What Are HOT Updates?

HOT (Heap Only Tuple) updates modify rows without updating indexes. This is 5-10x faster than regular updates.

Requirements:

1. Updated columns must NOT be indexed
2. New row version must fit on same 8KB page (fillfactor provides room)

### Our Configuration

- **Fillfactor = 70**: Leaves 30% free space on each page for row versions
- **Indicator columns not indexed**: `rsi_14`, `atr_14`, `cvd`, etc. are not in any index
- **Only query columns indexed**: `symbol`, `minute_index`, `timestamp`

### Verifying HOT Updates Work

```sql
-- Check HOT update ratio (should be >90%)
SELECT
    relname,
    n_tup_upd AS total_updates,
    n_tup_hot_upd AS hot_updates,
    CASE WHEN n_tup_upd > 0
         THEN round(100.0 * n_tup_hot_upd / n_tup_upd, 1)
         ELSE 0
    END AS hot_pct
FROM pg_stat_user_tables
WHERE relname LIKE 'ohlcv_%'
ORDER BY n_tup_upd DESC;
```

If HOT ratio is low:

1. Check if indicator columns are accidentally indexed
2. Increase fillfactor headroom (try 60)
3. Run VACUUM more frequently

## Bulk Operations

### Bulk Insert: Use COPY

```typescript
import { from as copyFrom } from "pg-copy-streams";

const stream = client.query(
  copyFrom(`
  COPY ohlcv_60m (timestamp, symbol, minute_index, open, high, low, close, volume)
  FROM STDIN WITH (FORMAT csv)
`),
);

readable.pipe(stream);
```

### Bulk Update: Use Staging Tables

```sql
-- 1. Create temp staging table
CREATE TEMP TABLE staging_indicators (
  timestamp TIMESTAMPTZ NOT NULL,
  symbol VARCHAR(20) NOT NULL,
  rsi_14 DOUBLE PRECISION
) ON COMMIT DROP;

-- 2. COPY data into staging
COPY staging_indicators FROM STDIN ...

-- 3. Index staging for efficient join
CREATE INDEX ON staging_indicators (symbol, timestamp);

-- 4. Single UPDATE with JOIN
UPDATE ohlcv_60m m
SET rsi_14 = s.rsi_14
FROM staging_indicators s
WHERE m.symbol = s.symbol AND m.timestamp = s.timestamp;
```

See `scripts/calculate-rsi.ts` for complete implementation.

## Maintenance Tasks

### Adding a New Symbol

```bash
# Create partitions for new symbol
npx ts-node scripts/db-advanced-setup.ts setup-partitions ohlcv_60m --symbols AAPL
```

### Adding a New Month (Extending Date Range)

```bash
# Partitions are created automatically by import script
# Or manually:
npx ts-node scripts/db-advanced-setup.ts setup-partitions ohlcv_60m --symbols ES
```

### Analyzing Tables After Bulk Operations

```sql
-- Update statistics for query planner
ANALYZE ohlcv_60m;
```

### Vacuuming

```sql
-- Regular vacuum (non-blocking, reclaims dead tuples)
VACUUM ohlcv_60m;

-- Full vacuum (blocking, rewrites table, reclaims disk space)
-- Only run during maintenance windows
VACUUM FULL ohlcv_60m;
```

## Monitoring Queries

### Partition Pruning Check

```sql
EXPLAIN (ANALYZE, COSTS OFF)
SELECT * FROM ohlcv_60m
WHERE symbol = 'ES'
  AND minute_index = 45
  AND timestamp BETWEEN '2024-03-01' AND '2024-03-31';

-- Should show only: ohlcv_60m_es_2024_03
```

### Table Sizes

```sql
SELECT
    schemaname,
    relname,
    pg_size_pretty(pg_total_relation_size(relid)) as total_size,
    pg_size_pretty(pg_relation_size(relid)) as table_size,
    pg_size_pretty(pg_indexes_size(relid)) as index_size
FROM pg_stat_user_tables
WHERE relname LIKE 'ohlcv_%'
ORDER BY pg_total_relation_size(relid) DESC;
```

### Partition Statistics

```sql
SELECT
    parent.relname as parent,
    child.relname as partition,
    pg_size_pretty(pg_relation_size(child.oid)) as size
FROM pg_inherits
JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
JOIN pg_class child ON pg_inherits.inhrelid = child.oid
WHERE parent.relname = 'ohlcv_60m_es'
ORDER BY child.relname;
```

## Workflow: Adding New Indicator Column

Complete workflow when adding a new indicator:

```bash
# 1. Edit prisma/schema.prisma - add column to ALL timeframe models

# 2. Create Prisma migration
npx prisma migrate dev --name add_ema_indicators

# 3. Regenerate client
npx prisma generate

# 4. Verify column exists
psql -c "SELECT column_name FROM information_schema.columns WHERE table_name = 'ohlcv_60m' AND column_name = 'ema_20'"

# 5. Calculate indicator values (custom script)
npx ts-node scripts/calculate-ema.ts ES 60

# 6. Analyze table
psql -c "ANALYZE ohlcv_60m"
```

## Troubleshooting

### "Cannot create partition of relation that is not partitioned"

The parent table was created by Prisma as a regular table. Run:

```bash
npx ts-node scripts/db-advanced-setup.ts convert-to-partitioned ohlcv_60m
```

### "No partition of relation found for row"

Data timestamp doesn't fit any existing partition. Create missing partition:

```sql
CREATE TABLE ohlcv_60m_es_2027_01 PARTITION OF ohlcv_60m_es
FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
```

### Slow queries not using partitions

Check EXPLAIN output. If scanning all partitions:

1. Ensure WHERE clause includes `symbol = 'X'` (not `symbol IN (...)`)
2. Check that timestamp range is specific enough

### Out of disk space during VACUUM FULL

VACUUM FULL needs ~2x table size temporarily. Options:

1. Vacuum partitions individually
2. Add disk space
3. Use regular VACUUM (doesn't reclaim as much but doesn't need extra space)

```

---

## Summary

| File | Purpose |
|------|---------|
| `prisma/schema.prisma` | Schema definition - Prisma source of truth |
| `src/lib/prisma.ts` | Prisma client singleton |
| `scripts/db-advanced-setup.ts` | Partitioning, fillfactor, advanced PostgreSQL |
| `docs/PRISMA_SKILL.md` | AI agent instructions for Prisma |
| `docs/ADVANCED_POSTGRES.md` | Manual for features Prisma can't handle |
```
