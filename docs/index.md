# Documentation

## Data Storage

How data is stored, ingested, and optimized in PostgreSQL.

- [overview.md](./data-storage/overview.md) -- Database schema design: one table per timeframe, minute_index cycling, indicator columns, partitioning
- [optimization.md](./data-storage/optimization.md) -- PostgreSQL performance: composite partitioning, HOT updates, staging table bulk writes

### OHLCV Ingestion
- [ohlcv/ingest-ohlcv-timeframe.md](./data-storage/ohlcv/ingest-ohlcv-timeframe.md) -- Rolling-window OHLCV aggregation pipeline with partitioned tables and COPY bulk inserts
- [ohlcv/ingest-ohlcv-timeframe.ts](./data-storage/ohlcv/ingest-ohlcv-timeframe.ts) -- TypeScript reference implementation (monotonic deque, SlidingWindowOHLCV, streaming inserts)

### Databento Data Feed
- [databento/ingesting/databento-historical-data.md](./data-storage/databento/ingesting/databento-historical-data.md) -- Importing historical OHLCV from Databento JSONL files
- [databento/ingesting/databento-live-data.md](./data-storage/databento/ingesting/databento-live-data.md) -- Live streaming via Databento Raw TCP API (CRAM auth, DBN parsing)
- [databento/indicators/tbbo.md](./data-storage/databento/indicators/tbbo.md) -- Live pipeline architecture: TBBO schema, metrics reference, data formats, pattern detection queries
- [databento/indicators/cvd-from-tbbo.md](./data-storage/databento/indicators/cvd-from-tbbo.md) -- Order flow research: OFI, absorption algorithms, delta signals, footprint analysis, VPIN

### Deprecated
- [deprecated/timescale-aggregators.md](./data-storage/deprecated/timescale-aggregators.md) -- Why TimescaleDB was rejected (compression conflicts with frequent updates, aggregators don't support sliding windows)

## Data Indicators

Calculating technical indicators at 1-minute resolution across all timeframes.

- [example/calculate-indicator-values.md](./data-indicators/example/calculate-indicator-values.md) -- How rolling-window indicator calculation works with minute_index parallelism
- [example/calculate-indicator-values.ts](./data-indicators/example/calculate-indicator-values.ts) -- TypeScript reference: RSI calculator with Wilder's smoothing, staging table bulk updates
- [rsi/README.md](./data-indicators/rsi/README.md) -- Sliding window RSI platform: architecture, minute_index trick, backtesting framework API
- [rsi/](./data-indicators/rsi/) -- JavaScript reference implementation (BacktestEngine, TimeframeBuffer, example strategies)

## Data Backtesting

Architecture for running strategies across millions of bars at multiple timeframes.

- [optimization.md](./data-backtesting/optimization.md) -- In-memory architecture: Float64Array buffers, zero-copy sliding windows, chunked DB loading
- [notes/README.md](./data-backtesting/notes/README.md) -- Order flow trading strategy overview: 4 core patterns (absorption + momentum)
- [notes/metrics-guide.md](./data-backtesting/notes/metrics-guide.md) -- Complete metric reference: VD, CVD, VD Ratio, book imbalance, divergence, EVR, SMP, and more
- [notes/pattern-detection.md](./data-backtesting/notes/pattern-detection.md) -- SQL queries for detecting bearish/bullish absorption and momentum patterns
- [notes/absorption-theory.md](./data-backtesting/notes/absorption-theory.md) -- Theory of institutional absorption: accumulation, distribution, iceberg orders
- [notes/suggested-metrics.md](./data-backtesting/notes/suggested-metrics.md) -- Future metrics to implement: imbalance streak, CVD slope, volume spike, delta exhaustion

## Data Analysis

Research on pivot detection and predictive modeling (Python).

- [python/overview.md](./data-analysis/python/overview.md) -- Library comparison: TA-Lib (cycles), scipy (pivots), VectorBT (backtesting), and alternatives
- [python/high-low-detection.md](./data-analysis/python/high-low-detection.md) -- Pivot detection methods: find_peaks, Williams Fractals, rolling window extrema
- [python/scripts/pivot-timing-analysis.py](./data-analysis/python/scripts/pivot-timing-analysis.py) -- X-axis analysis: wavelength timing between swing highs/lows, Hilbert cycle detection
- [python/scripts/pivot-trajectory-analysis.py](./data-analysis/python/scripts/pivot-trajectory-analysis.py) -- Y-axis analysis: price trajectory alignment using linear regression on pivot sequences

## Hosting

- [prisma-schema-as-code.md](./hosting/prisma-schema-as-code.md) -- Prisma ORM setup: schema definitions, migration workflow, advanced PostgreSQL features Prisma can't handle
