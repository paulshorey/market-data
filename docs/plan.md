# Implementation Plan

1. 1-min OHLCV table
2.

## Done:

### Live Data Pipeline

- [x] Databento TCP client streaming TBBO tick data (`src/stream/tbbo-stream.ts`)
- [x] 1-minute candle aggregation with OHLC tracking (`src/stream/tbbo-aggregator.ts`)
- [x] Auto-reconnection with exponential backoff
- [x] Writes to `"candles-1m"` table every second (54 columns)

### Order Flow Metrics

- [x] VD, VD Ratio, CVD (`src/lib/metrics/direction.ts`)
- [x] Book Imbalance (`src/lib/metrics/book-imbalance.ts`)
- [x] Divergence, EVR (`src/lib/metrics/absorption.ts`)
- [x] SMP composite score (`src/lib/metrics/composite.ts`)
- [x] VD Strength (`src/lib/metrics/momentum.ts`)
- [x] VWAP, spread BPS, price percent (`src/lib/metrics/price.ts`)
- [x] Trade size, big trades (`src/lib/metrics/activity.ts`)
- [x] OHLC tracking for all metrics (`src/lib/metrics/ohlc.ts`)

### REST API

- [x] `/health` -- DB + stream status (`src/api/health/v1.ts`)
- [x] `/tables` -- Schema introspection (`src/api/tables/v1.ts`)
- [x] `/historical/candles` -- Candle data with auto-timeframe selection (`src/api/historical/candles/v1.ts`)
- [x] `/historical/range` -- Date range for a ticker (`src/api/historical/range/v1.ts`)

### Data Ingestion Scripts

- [x] Historical OHLCV import with continuous contract building (`scripts/import-databento.ts`)
- [x] Historical TBBO tick-by-tick import (`scripts/historical-tbbo.ts`)
- [x] Pattern detection analysis (`scripts/detect-patterns.ts`)
- [x] TimescaleDB to PostgreSQL migration (`scripts/migrate-timescale-to-postgres.ts`)

### Documentation

- [x] Database schema design (`docs/data-storage/overview.md`)
- [x] PostgreSQL optimization guide (`docs/data-storage/optimization.md`)
- [x] OHLCV ingestion reference implementation (`docs/data-storage/ohlcv/`)
- [x] Databento data feed docs (`docs/data-storage/databento/`)
- [x] Order flow metrics guide (`docs/data-backtesting/notes/metrics-guide.md`)
- [x] Pattern detection queries (`docs/data-backtesting/notes/pattern-detection.md`)
- [x] RSI indicator reference with backtesting framework (`docs/data-indicators/rsi/`)
- [x] Pivot detection research (`docs/data-analysis/python/`)
- [x] Prisma schema reference (`docs/hosting/prisma-schema-as-code.md`)

### Client-Side Charting

- [x] Done in a different app. This app is strictly for managing the data.

## To do:

### Multi-Timeframe Tables

- [ ] Create `ohlcv_1m` table (migrate from `"candles-1m"`)
- [ ] Create higher-timeframe tables (`ohlcv_3m`, `ohlcv_5m`, `ohlcv_15m`, `ohlcv_60m`, etc.)
- [ ] Composite partitioning: LIST by symbol, RANGE by month
- [ ] Rolling-window pre-processing pipeline (aggregate 1m into higher timeframes every minute)
- [ ] `minute_index` cycling for each timeframe
- [ ] Reference: `docs/data-storage/overview.md`, `docs/data-storage/ohlcv/ingest-ohlcv-timeframe.ts`

### Indicator Calculation Pipeline

- [ ] RSI-14 across all timeframes using minute_index approach
- [ ] EMA (9, 21), SMA (50, 200)
- [ ] MACD (line, signal, histogram)
- [ ] ATR-14
- [ ] Parallel minute_index processing with staging table bulk updates
- [ ] Reference: `docs/data-indicators/example/`, `docs/data-indicators/rsi/`

### Advanced Order Flow (from research)

- [ ] VPIN (Volume-Synchronized Probability of Informed Trading)
- [ ] Footprint chart analysis
- [ ] Volume profile (POC, Value Area)
- [ ] Stacked imbalance detection
- [ ] Reference: `docs/data-storage/databento/indicators/cvd-from-tbbo.md`

### Additional Metrics

- [ ] Imbalance streak (consecutive candles with same VD sign)
- [ ] CVD slope (rate of change)
- [ ] Volume spike (current vs 20-period average)
- [ ] Absorption intensity (normalized score)
- [ ] Delta exhaustion (extreme delta followed by quiet)
- [ ] Reference: `docs/data-backtesting/notes/suggested-metrics.md`

### Backtesting Engine

- [ ] In-memory Float64Array buffers per timeframe per column
- [ ] 5,000-bar sliding window with zero-copy index math
- [ ] Chunked database loading (100k-500k rows)
- [ ] Strategy API: `ctx.tf(minutes)`, `ctx.buy()`, `ctx.sell()`, `ctx.close()`
- [ ] Multi-timeframe confluence (strategy accesses all timeframes at any minute)
- [ ] Trade logging, equity curve, performance metrics
- [ ] Reference: `docs/data-backtesting/optimization.md`, `docs/data-indicators/rsi/BacktestEngine.js`

### Pivot Detection (Python)

- [ ] scipy `find_peaks` for swing high/low detection
- [ ] TA-Lib Hilbert Transform for cycle analysis (HT_DCPERIOD, HT_DCPHASE)
- [ ] Wavelength timing analysis (X-axis)
- [ ] Trajectory alignment scoring (Y-axis)
- [ ] Reference: `docs/data-analysis/python/`
