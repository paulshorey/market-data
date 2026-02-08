# Market Data Platform

Multi-timeframe financial data pipeline for futures and crypto. Ingests live trade data, aggregates into candles with order flow metrics, and serves via REST API. The long-term goal is a backtesting platform where strategies can reference any timeframe at 1-minute resolution.

See [docs/plan.md](docs/plan.md) for what's built and what's next.

## Core Innovation: Rolling-Window Sampling

Standard platforms calculate a 60-minute candle once per hour. This platform calculates it **every minute** using a sliding window over the previous 60 minutes. This means:

- A 60m table has one row per minute (not per hour), each representing the trailing 60-minute window
- `minute_index` cycles 0-59, identifying which phase of the timeframe the row represents
- Indicators like RSI are calculated per minute_index independently (60 separate RSI calculators for a 60m timeframe)
- Backtesting can evaluate any timeframe at any minute, not just at period boundaries

**Example**: To get RSI-14 on 60m data at 10:31 (minute_index=31), query 14 rows where `minute_index=31` ordered by timestamp DESC. Each row is 60 minutes apart (9:31, 8:31, 7:31...) -- exactly what the indicator needs.

```sql
SELECT close FROM ohlcv_60m
WHERE symbol = 'ES' AND minute_index = 31
ORDER BY ts DESC LIMIT 14;
```

## Tech Stack

- **Runtime**: Node.js / TypeScript (strict mode)
- **API**: Express
- **Database**: PostgreSQL via `pg` (raw SQL, no ORM in production)
- **Data feed**: Databento Raw TCP API (TBBO schema)
- **Deployment**: Railway

## Database Conventions

- Table names: `ohlcv_{interval}m` (e.g., `ohlcv_60m`). One table per timeframe, all sharing the same schema.
- Primary key: `(symbol, ts)`. All symbols share one table, differentiated by `symbol` column.
- Critical index: `(symbol, minute_index, ts DESC)` for indicator lookups.
- `minute_index` cycles 0 to N-1 for an N-minute timeframe.
- Column names: snake_case in DB, camelCase in TypeScript.
- Indicators stored in same row as OHLCV (no JOINs needed).

See [docs/data-storage/overview.md](docs/data-storage/overview.md) for full schema, partitioning, and query patterns.

## Project Structure

```
src/
  index.ts                  # Express server entry point
  api/                      # REST endpoints (health, tables, historical candles)
  lib/
    db.ts                   # PostgreSQL connection pool
    candles.ts              # Candle querying + timeframe selection
    trade/                  # TBBO processing (aggregation, side detection, thresholds)
    metrics/                # 10 order flow metric calculators (VD, CVD, EVR, SMP, etc.)
  stream/                   # Databento live TCP client + aggregator
scripts/                    # Data import and analysis tools
docs/                       # Architecture docs, examples, research notes
```

## Documentation

See [docs/index.md](docs/index.md) for the full map. Key sections:

- **data-storage/**: Database schema, partitioning, optimization, Databento ingestion
- **data-indicators/**: Indicator calculation with rolling windows, RSI reference implementation
- **data-backtesting/**: Backtesting architecture, order flow patterns, optimization
- **data-analysis/**: Pivot detection research, Python analysis scripts
