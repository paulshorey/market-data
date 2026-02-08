# Market Data Platform

Multi-timeframe financial data pipeline for futures and crypto. Ingests live trade data, aggregates into candles with order flow metrics, and serves via REST API. The long-term goal is a backtesting platform where strategies can reference any timeframe (1-second to 1-day) at 1-minute resolution.

## Core Innovation: Rolling-Window Sampling

Standard platforms calculate a 60-minute candle once per hour. This platform calculates it **every minute** using a sliding window over the previous 60 minutes. This means:

- A 60m table has one row per minute (not per hour), each representing the trailing 60-minute window
- `minute_index` cycles 1-60, identifying which phase of the timeframe the row represents
- Indicators like RSI are calculated per minute_index independently (60 separate RSI calculators for a 60m timeframe)
- Backtesting can evaluate any timeframe at any minute, not just at period boundaries

**Example**: To get RSI-14 on 60m data at 10:31 (minute_index=31), query 14 rows where `minute_index=31` ordered by timestamp DESC. Each row is 60 minutes apart (9:31, 8:31, 7:31...) -- exactly what the indicator needs.

```sql
SELECT close FROM ohlcv_60m
WHERE symbol = 'ES' AND minute_index = 31
ORDER BY ts DESC LIMIT 14;
```

## What's Built

### Live Data Pipeline (`src/stream/`)
- Databento TCP client streaming TBBO (Trade-By-Order) tick data
- 1-minute candle aggregation with 10 order flow metrics, each tracked as OHLC (54 columns total)
- Writes to `"candles-1m"` table every second
- Auto-reconnection with exponential backoff

### Order Flow Metrics (`src/lib/metrics/`)
- **VD / VD Ratio**: Volume delta (aggressive buyer/seller pressure), normalized -1 to +1
- **CVD**: Cumulative volume delta, persistent across candles
- **Book Imbalance**: Passive order flow from limit order book
- **Divergence**: Flags absorption (price moves opposite to aggressive flow)
- **EVR**: Effort vs Result absorption score
- **SMP**: Smart Money Pressure composite (-100 to +100)
- **VD Strength**: Momentum acceleration/deceleration
- **Price metrics**: VWAP, spread BPS, price percent change
- **Activity**: Average/max trade size, big trade count

### REST API (`src/api/`)
| Endpoint | Purpose |
|----------|---------|
| `GET /health` | DB + stream status |
| `GET /tables` | Schema introspection |
| `GET /historical/candles` | Candle data with auto-timeframe selection |
| `GET /historical/range` | Date range for a ticker |

Auto-timeframe selection picks the smallest timeframe that keeps ~1000 candles for the requested range. Available timeframes: 1m, 3m, 7m, 19m, 29m, 59m, 109m, 181m, 1d, 1w.

### Data Ingestion (`scripts/`)
- `import-databento.ts` -- Historical OHLCV import with continuous contract building
- `historical-tbbo.ts` -- Historical tick-by-tick import using same aggregation as live
- `detect-patterns.ts` -- Pattern detection analysis (absorption, momentum)
- `migrate-timescale-to-postgres.ts` -- Database migration tool

## What's Planned (Not Yet Built)

1. **Multi-timeframe tables**: One table per timeframe (ohlcv_1m, ohlcv_5m, ohlcv_60m, ohlcv_1440m, etc.) with rolling-window pre-processing
2. **Indicator calculation pipeline**: RSI, EMA, MACD, ATR across all timeframes using the minute_index approach
3. **Backtesting engine**: In-memory execution with 5,000-bar sliding windows per timeframe, chunked loading, strategy API
4. **Pivot detection**: Python-based cycle analysis using TA-Lib Hilbert Transform + scipy for timing/trajectory prediction
5. **Client-side charting**: Visualization of candles, indicators, and backtest results

## Tech Stack

- **Runtime**: Node.js / TypeScript (strict mode)
- **API**: Express
- **Database**: PostgreSQL via `pg` (raw SQL, no ORM in production)
- **Data feed**: Databento Raw TCP API (TBBO schema)
- **Deployment**: Railway

## Database Architecture

### Current
Single `"candles-1m"` table with 54 columns (OHLCV + all order flow metrics as OHLC).

### Target
One table per timeframe, all sharing the same schema:

```
ohlcv_1m   (source of truth, raw from live stream)
ohlcv_3m   (rolling window, calculated from 1m)
ohlcv_5m
ohlcv_15m
ohlcv_60m
ohlcv_120m
ohlcv_240m
ohlcv_720m
ohlcv_1440m (1 day)
```

Key schema elements:
- **Primary key**: `(symbol, ts)`
- **Critical index**: `(symbol, minute_index, ts DESC)` for indicator lookups
- **Composite partitioning**: LIST by symbol, then RANGE by month
- **HOT updates**: `fillfactor=70` so indicator column updates skip index maintenance
- **Bulk writes**: Staging table + COPY pattern (50-100x faster than row-by-row)

### Conventions
- Table names: `ohlcv_{interval}m` (e.g., `ohlcv_60m`)
- Column names: snake_case in DB, camelCase in TypeScript
- All symbols share one table, differentiated by `symbol` column
- Indicators stored in same row as OHLCV (no JOINs needed)
- `minute_index` cycles 1 to N for an N-minute timeframe

## Project Structure

```
src/
  index.ts                  # Express server entry point
  api/                      # REST endpoints
  lib/
    db.ts                   # PostgreSQL connection pool
    candles.ts              # Candle querying + timeframe selection
    trade/                  # TBBO processing (aggregation, side detection, thresholds)
    metrics/                # Order flow metric calculators
  stream/                   # Databento live TCP client + aggregator
scripts/                    # Data import and analysis tools
docs/                       # Architecture docs, examples, research notes
```

## Documentation

See `docs/index.md` for the full documentation map. Key sections:

- **data-storage/**: Database schema, partitioning, optimization, Databento ingestion
- **data-indicators/**: Indicator calculation with rolling windows, RSI reference implementation
- **data-backtesting/**: Backtesting architecture, order flow patterns, optimization
- **data-analysis/**: Pivot detection research, Python analysis scripts
- **hosting/**: Prisma schema reference, deployment
