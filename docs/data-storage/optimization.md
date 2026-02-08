# PostgreSQL Optimization

> For database schema design, see [overview.md](./overview.md). This document covers performance optimization techniques.

## Composite Partitioning

Partitioning divides a single logical table into multiple physical pieces. PostgreSQL's query planner automatically routes queries to only the relevant partitions—this is called **partition pruning**. With 200 million rows, proper partitioning can reduce query scans from the full dataset down to just the relevant slice.

**Composite partitioning** means partitioning by multiple columns in a hierarchy. For your workload, the optimal structure is LIST partitioning by ticker first, then RANGE partitioning by timestamp within each ticker.

### Why this structure works for you

Your queries filter by ticker, minute, and timestamp range. Since ticker is always an equality condition (`WHERE ticker = 'ES'`), partitioning by ticker first immediately eliminates ~95% of data (19 of 20 tickers). The timestamp range filter then prunes further within that ticker's partitions.

### Creating the partitioned structure

```sql
-- Parent table defines the schema and first partition level
CREATE TABLE market_data (
    id BIGSERIAL,
    timestamp TIMESTAMPTZ NOT NULL,
    ticker VARCHAR(10) NOT NULL,
    minute SMALLINT NOT NULL,
    open NUMERIC(12,4),
    high NUMERIC(12,4),
    low NUMERIC(12,4),
    close NUMERIC(12,4),
    volume BIGINT,
    sma_20 NUMERIC(12,4),
    rsi_14 NUMERIC(12,4),
    macd NUMERIC(12,4),
    macd_signal NUMERIC(12,4),
    bollinger_upper NUMERIC(12,4),
    bollinger_lower NUMERIC(12,4),
    PRIMARY KEY (ticker, timestamp, id)
) PARTITION BY LIST (ticker);

-- Create a partition for each ticker
CREATE TABLE market_data_es PARTITION OF market_data
    FOR VALUES IN ('ES')
    PARTITION BY RANGE (timestamp);

CREATE TABLE market_data_nq PARTITION OF market_data
    FOR VALUES IN ('NQ')
    PARTITION BY RANGE (timestamp);

CREATE TABLE market_data_cl PARTITION OF market_data
    FOR VALUES IN ('CL')
    PARTITION BY RANGE (timestamp);

-- Repeat for each ticker...
```

### Sub-partitioning by time

Within each ticker partition, create monthly sub-partitions:

```sql
-- Sub-partitions for ES by month
CREATE TABLE market_data_es_2024_01 PARTITION OF market_data_es
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');

CREATE TABLE market_data_es_2024_02 PARTITION OF market_data_es
    FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');

CREATE TABLE market_data_es_2024_03 PARTITION OF market_data_es
    FOR VALUES FROM ('2024-03-01') TO ('2024-04-01');

-- Continue for each month...
```

### Automating partition creation

Manually creating partitions is tedious. Use a function to generate them:

```sql
CREATE OR REPLACE FUNCTION create_monthly_partitions(
    parent_table TEXT,
    ticker_symbol TEXT,
    start_date DATE,
    end_date DATE
) RETURNS VOID AS $$
DECLARE
    current_date DATE := start_date;
    partition_name TEXT;
    next_month DATE;
BEGIN
    WHILE current_date < end_date LOOP
        next_month := current_date + INTERVAL '1 month';
        partition_name := format('%s_%s_%s',
            parent_table,
            lower(ticker_symbol),
            to_char(current_date, 'YYYY_MM')
        );

        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I
             FOR VALUES FROM (%L) TO (%L)',
            partition_name,
            parent_table || '_' || lower(ticker_symbol),
            current_date,
            next_month
        );

        current_date := next_month;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Create partitions for ES from 2020 through 2026
SELECT create_monthly_partitions('market_data', 'ES', '2020-01-01', '2027-01-01');
SELECT create_monthly_partitions('market_data', 'NQ', '2020-01-01', '2027-01-01');
-- Repeat for other tickers...
```

### Indexing the partitioned table

Create a composite index matching your query pattern. PostgreSQL automatically creates the same index on each partition:

```sql
-- This index supports: WHERE ticker = 'ES' AND minute = 45 AND timestamp BETWEEN x AND y
CREATE INDEX idx_market_data_lookup
    ON market_data (ticker, minute, timestamp);
```

The column order matters. Equality columns (`ticker`, `minute`) come first, range column (`timestamp`) comes last. This allows the index to efficiently find all rows matching the equality conditions, then scan the relevant timestamp range.

### Verifying partition pruning

Use `EXPLAIN` to confirm PostgreSQL prunes irrelevant partitions:

```sql
EXPLAIN (ANALYZE, COSTS OFF)
SELECT * FROM market_data
WHERE ticker = 'ES'
  AND minute = 45
  AND timestamp BETWEEN '2024-03-01' AND '2024-03-31';
```

You should see only `market_data_es_2024_03` being scanned, not all partitions.

---

## HOT Update Optimization

HOT stands for **Heap Only Tuple**. It's PostgreSQL's mechanism for updating rows without creating new index entries—dramatically faster than regular updates.

### How PostgreSQL updates normally work

When you update a row in PostgreSQL, it doesn't modify the row in place. Instead, it creates a new version of the row (MVCC architecture) and marks the old version as dead. If the updated row has indexed columns, PostgreSQL must also insert new entries into every index pointing to the new row location.

For a table with 5 indexes, a single row update means 1 heap write + 5 index writes. At scale, index maintenance dominates update time.

### How HOT updates work

A HOT update creates the new row version on the **same heap page** as the old version and chains them together. No index entries are created because the existing index entries still point to the same page—PostgreSQL follows the chain to find the current version.

HOT updates are dramatically faster, but they require two conditions:

1. **The updated columns are not indexed.** If you change an indexed column, PostgreSQL must update the index.
2. **There's free space on the same page.** The new row version must fit on the same 8KB page as the old version.

### Configuring for HOT updates

**First, don't index your indicator columns.** Since you query by ticker, minute, and timestamp—but update indicator values—keep indexes only on the query columns:

```sql
-- Good: index only on query columns
CREATE INDEX idx_market_data_lookup ON market_data (ticker, minute, timestamp);

-- Bad: don't do this if you update indicators frequently
CREATE INDEX idx_indicators ON market_data (sma_20, rsi_14);  -- DON'T
```

**Second, set fillfactor to reserve space for updates:**

```sql
-- For existing table
ALTER TABLE market_data SET (fillfactor = 70);

-- For new table at creation
CREATE TABLE market_data (
    -- columns...
) WITH (fillfactor = 70)
PARTITION BY LIST (ticker);
```

A fillfactor of 70 means PostgreSQL only fills each 8KB page to 70% capacity during inserts, leaving 30% free for future row versions. The trade-off is ~43% more disk space for the table data.

After changing fillfactor on an existing table, you need to rewrite it for the setting to take effect:

```sql
-- Rewrite table to apply new fillfactor
VACUUM FULL market_data;
-- Or rebuild specific partitions
ALTER TABLE market_data_es_2024_03 SET (fillfactor = 70);
VACUUM FULL market_data_es_2024_03;
```

### Monitoring HOT update effectiveness

Check how many updates are using HOT:

```sql
SELECT
    schemaname,
    relname,
    n_tup_upd AS total_updates,
    n_tup_hot_upd AS hot_updates,
    CASE WHEN n_tup_upd > 0
         THEN round(100.0 * n_tup_hot_upd / n_tup_upd, 1)
         ELSE 0
    END AS hot_update_percent
FROM pg_stat_user_tables
WHERE relname LIKE 'market_data%'
ORDER BY n_tup_upd DESC;
```

Target >90% HOT update ratio. If you're seeing lower numbers:

- Check if you accidentally indexed an indicator column
- Increase fillfactor headroom (try 60 instead of 70)
- Run `VACUUM` more frequently to reclaim dead tuple space

### Page-level behavior visualization

```
Before update (fillfactor = 70):
┌─────────────────────────────────────┐
│ Row 1 │ Row 2 │ Row 3 │   FREE 30%  │  <- Page has room
└─────────────────────────────────────┘

After HOT update to Row 2:
┌─────────────────────────────────────┐
│ Row 1 │ Row 2 │ Row 3 │ Row 2' │FREE│  <- New version on same page
│       │(dead) │       │(live)  │    │
└─────────────────────────────────────┘
         ↓ chain pointer ↗

Index still points to original Row 2 location.
PostgreSQL follows chain to find Row 2' (current version).
```

---

## Bulk Update via Staging Tables

When updating millions of rows, row-by-row updates are catastrophically slow. The staging table pattern batches all changes into a single operation.

### The problem with naive updates

```sql
-- Terrible performance: 10 million separate UPDATE statements
UPDATE market_data SET sma_20 = 100.5 WHERE id = 1;
UPDATE market_data SET sma_20 = 101.2 WHERE id = 2;
UPDATE market_data SET sma_20 = 99.8 WHERE id = 3;
-- ... 10 million more
```

Each statement has overhead: parse, plan, execute, commit. Network round-trips if using a client. Transaction log writes. This could take hours or days.

### The staging table pattern

**Step 1: Create a temporary staging table**

```sql
CREATE TEMP TABLE staging_indicators (
    ticker VARCHAR(10) NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    sma_20 NUMERIC(12,4),
    rsi_14 NUMERIC(12,4),
    macd NUMERIC(12,4),
    macd_signal NUMERIC(12,4),
    bollinger_upper NUMERIC(12,4),
    bollinger_lower NUMERIC(12,4)
) ON COMMIT DROP;

-- Temporary tables are not logged and auto-cleanup on disconnect
-- ON COMMIT DROP removes it when transaction commits (optional)
```

**Step 2: Bulk load data with COPY**

`COPY` is PostgreSQL's fastest data loading mechanism—3-10x faster than INSERT:

```sql
-- From a file
COPY staging_indicators FROM '/path/to/indicators.csv' WITH (FORMAT csv, HEADER true);

-- From Node.js using pg-copy-streams (shown later)
```

**Step 3: Single UPDATE with JOIN**

```sql
UPDATE market_data m
SET
    sma_20 = s.sma_20,
    rsi_14 = s.rsi_14,
    macd = s.macd,
    macd_signal = s.macd_signal,
    bollinger_upper = s.bollinger_upper,
    bollinger_lower = s.bollinger_lower
FROM staging_indicators s
WHERE m.ticker = s.ticker
  AND m.timestamp = s.timestamp;
```

This executes as a single operation. PostgreSQL can use efficient join algorithms (hash join, merge join) and process millions of rows in one transaction.

**Step 4: Analyze to update statistics**

```sql
ANALYZE market_data;
```

### Optimizing the bulk update further

**Index the staging table's join columns:**

```sql
CREATE INDEX idx_staging_lookup ON staging_indicators (ticker, timestamp);
```

This allows PostgreSQL to use an efficient merge join or index nested loop instead of a hash join, which can be faster for very large updates.

**Process by partition for parallelism and smaller transactions:**

```sql
-- Update one ticker at a time to reduce lock contention and transaction size
DO $$
DECLARE
    t TEXT;
BEGIN
    FOR t IN SELECT DISTINCT ticker FROM staging_indicators LOOP
        UPDATE market_data m
        SET
            sma_20 = s.sma_20,
            rsi_14 = s.rsi_14,
            macd = s.macd,
            macd_signal = s.macd_signal
        FROM staging_indicators s
        WHERE m.ticker = s.ticker
          AND m.timestamp = s.timestamp
          AND m.ticker = t;

        RAISE NOTICE 'Updated ticker: %', t;
        COMMIT;  -- Requires PostgreSQL 11+ procedure, or run as separate statements
    END LOOP;
END $$;
```

**Disable indexes during massive updates (use cautiously):**

For truly massive updates affecting most of the table, dropping and recreating indexes can be faster than maintaining them during updates:

```sql
-- Drop indexes
DROP INDEX idx_market_data_lookup;

-- Perform bulk update
UPDATE market_data m SET ... FROM staging_indicators s WHERE ...;

-- Recreate indexes (uses parallel workers in PostgreSQL 11+)
CREATE INDEX idx_market_data_lookup ON market_data (ticker, minute, timestamp);
```

### Node.js implementation

```javascript
const { Pool } = require("pg");
const { from: copyFrom } = require("pg-copy-streams");
const { Readable } = require("stream");

const pool = new Pool({
  host: "localhost",
  database: "market_db",
  user: "your_user",
  password: "your_password",
  max: 10,
});

async function bulkUpdateIndicators(indicatorData) {
  // indicatorData is an array of objects:
  // [{ ticker: 'ES', timestamp: '2024-03-15T09:30:00Z', sma_20: 5100.25, ... }, ...]

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Step 1: Create temp table
    await client.query(`
            CREATE TEMP TABLE staging_indicators (
                ticker VARCHAR(10) NOT NULL,
                timestamp TIMESTAMPTZ NOT NULL,
                sma_20 NUMERIC(12,4),
                rsi_14 NUMERIC(12,4),
                macd NUMERIC(12,4),
                macd_signal NUMERIC(12,4),
                bollinger_upper NUMERIC(12,4),
                bollinger_lower NUMERIC(12,4)
            ) ON COMMIT DROP
        `);

    // Step 2: Stream data via COPY
    await new Promise((resolve, reject) => {
      const copyStream = client.query(
        copyFrom(
          `COPY staging_indicators (ticker, timestamp, sma_20, rsi_14, macd, macd_signal, bollinger_upper, bollinger_lower)
                 FROM STDIN WITH (FORMAT csv)`,
        ),
      );

      const csvData = indicatorData
        .map((row) => [row.ticker, row.timestamp, row.sma_20, row.rsi_14, row.macd, row.macd_signal, row.bollinger_upper, row.bollinger_lower].join(","))
        .join("\n");

      const readable = Readable.from([csvData]);
      readable.pipe(copyStream).on("finish", resolve).on("error", reject);
    });

    // Step 3: Create index on staging for efficient join
    await client.query(`
            CREATE INDEX ON staging_indicators (ticker, timestamp)
        `);

    // Step 4: Bulk update via JOIN
    const result = await client.query(`
            UPDATE market_data m
            SET 
                sma_20 = s.sma_20,
                rsi_14 = s.rsi_14,
                macd = s.macd,
                macd_signal = s.macd_signal,
                bollinger_upper = s.bollinger_upper,
                bollinger_lower = s.bollinger_lower
            FROM staging_indicators s
            WHERE m.ticker = s.ticker 
              AND m.timestamp = s.timestamp
        `);

    await client.query("COMMIT");

    console.log(`Updated ${result.rowCount} rows`);
    return result.rowCount;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// For very large updates, process in chunks by ticker
async function bulkUpdateByTicker(indicatorData) {
  // Group data by ticker
  const byTicker = indicatorData.reduce((acc, row) => {
    (acc[row.ticker] = acc[row.ticker] || []).push(row);
    return acc;
  }, {});

  let totalUpdated = 0;

  for (const [ticker, rows] of Object.entries(byTicker)) {
    const updated = await bulkUpdateIndicators(rows);
    totalUpdated += updated;
    console.log(`Completed ${ticker}: ${updated} rows`);
  }

  return totalUpdated;
}
```

### Performance comparison

For updating 10 million indicator values:

| Method                         | Approximate Time |
| ------------------------------ | ---------------- |
| Individual UPDATE statements   | 8-24 hours       |
| Batched INSERT...ON CONFLICT   | 30-60 minutes    |
| Staging table + single UPDATE  | 5-15 minutes     |
| Staging + UPDATE per partition | 3-10 minutes     |

The staging table approach is typically 50-100x faster than row-by-row updates.

---

## Putting It All Together

Here's the complete setup for your financial time-series database:

```sql
-- 1. Create partitioned table with proper fillfactor
CREATE TABLE market_data (
    id BIGSERIAL,
    timestamp TIMESTAMPTZ NOT NULL,
    ticker VARCHAR(10) NOT NULL,
    minute SMALLINT NOT NULL,
    open NUMERIC(12,4),
    high NUMERIC(12,4),
    low NUMERIC(12,4),
    close NUMERIC(12,4),
    volume BIGINT,
    sma_20 NUMERIC(12,4),
    rsi_14 NUMERIC(12,4),
    macd NUMERIC(12,4),
    macd_signal NUMERIC(12,4),
    bollinger_upper NUMERIC(12,4),
    bollinger_lower NUMERIC(12,4),
    PRIMARY KEY (ticker, timestamp, id)
) PARTITION BY LIST (ticker)
WITH (fillfactor = 70);

-- 2. Create ticker partitions with time sub-partitions
-- (Use the function shown earlier to automate this)

-- 3. Create composite index for your query pattern
-- Note: only query columns, NOT indicator columns
CREATE INDEX idx_market_data_lookup
    ON market_data (ticker, minute, timestamp);

-- 4. Configure autovacuum for update-heavy workload
ALTER TABLE market_data SET (
    autovacuum_vacuum_scale_factor = 0,
    autovacuum_vacuum_threshold = 500000,
    autovacuum_analyze_scale_factor = 0,
    autovacuum_analyze_threshold = 500000
);
```

With this setup:

- Queries filter efficiently through partition pruning and the composite index
- Updates to indicator columns use HOT updates (no index maintenance)
- Bulk updates via staging tables complete in minutes rather than hours
- Autovacuum runs frequently enough to reclaim dead tuple space
