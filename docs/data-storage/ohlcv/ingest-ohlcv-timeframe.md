# OHLCV Timeframe Ingestion

> **Status:** Reference implementation in [ingest-ohlcv-timeframe.ts](./ingest-ohlcv-timeframe.ts). Not yet integrated into the production pipeline.

Connects to 1-minute timeframe table.

Streams data from first entry until last entry.

Aggregates 1-minute rows into the specified higher timeframe.

## Key Optimizations Implemented

| Optimization                      | Implementation                                                 |
| --------------------------------- | -------------------------------------------------------------- |
| **Composite partitioning**        | LIST by symbol → RANGE by month                                |
| **Fillfactor 70**                 | Set on parent table and all partitions for HOT updates         |
| **B-tree composite index**        | `(symbol, minute_index, timestamp)` for query pattern          |
| **Indicator columns not indexed** | RSI, ATR, CVD columns can be updated without index maintenance |
| **Bulk insert via COPY**          | 10-50x faster than INSERT statements                           |
| **Autovacuum tuning**             | Configured for update-heavy workload                           |
| **Partition pre-creation**        | All month partitions created before data load                  |

## Table Structure

```
ohlcv_60m (parent, partitioned by LIST on symbol)
├── ohlcv_60m_es (symbol partition, partitioned by RANGE on timestamp)
│   ├── ohlcv_60m_es_2014_01
│   ├── ohlcv_60m_es_2014_02
│   ├── ...
│   └── ohlcv_60m_es_2026_12
├── ohlcv_60m_nq
│   ├── ohlcv_60m_nq_2014_01
│   └── ...
└── ohlcv_60m_cl
    └── ...
```

## Usage

```bash
# Install dependencies
npm install pg pg-copy-streams
npm install -D @types/pg

# Basic import
npx ts-node scripts/ingest-ohlcv-timeframe.ts ES 60

# Pre-create partitions for multiple symbols without importing
npx ts-node scripts/ingest-ohlcv-timeframe.ts ES 60 \
  --setup-only \
  --symbols ES,NQ,CL,GC,AAPL,MSFT \
  --start-date 2014-01-01 \
  --end-date 2027-01-01

# Import multiple timeframes
for tf in 5 13 30 60 181 240; do
  npx ts-node scripts/ingest-ohlcv-timeframe.ts ES $tf
done
```

## Verify Partition Pruning

After importing, verify queries only scan relevant partitions:

```sql
EXPLAIN (ANALYZE, COSTS OFF)
SELECT * FROM ohlcv_60m
WHERE symbol = 'ES'
  AND minute_index = 45
  AND timestamp BETWEEN '2024-03-01' AND '2024-03-31';
```

Expected output should show only `ohlcv_60m_es_2024_03` being scanned.

## Monitor HOT Updates

When you later update indicator columns:

```sql
SELECT
    relname,
    n_tup_upd AS total_updates,
    n_tup_hot_upd AS hot_updates,
    CASE WHEN n_tup_upd > 0
         THEN round(100.0 * n_tup_hot_upd / n_tup_upd, 1)
         ELSE 0
    END AS hot_update_pct
FROM pg_stat_user_tables
WHERE relname LIKE 'ohlcv_%'
ORDER BY n_tup_upd DESC;
```

Target >90% HOT update ratio.
