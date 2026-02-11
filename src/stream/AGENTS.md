# Live Streaming Data Processing

Real-time TBBO trade data from Databento, aggregated into rolling 1-minute candles at 1-second resolution and written to the `candles_1m` table. Each row represents the trailing 60-second window of trade data, producing up to 60 rows per minute per ticker.

## How It Works

- **`tbbo-stream.ts`** connects to Databento's Raw TCP API, authenticates, and subscribes to TBBO (Top of Book on Trade) data for configured symbols
  - Parses newline-delimited JSON messages from the socket
  - Builds an instrument_id-to-symbol lookup from symbol mapping messages (rtype=22)
  - Converts trade messages (action="T") into `TbboRecord` objects
  - Skips spread contracts (symbols containing "-") and trades during market closed hours
  - Passes each valid trade to the aggregator

- **`tbbo-1m-aggregator.ts`** collects trades into rolling 1-minute candles at 1-second resolution and writes them to `candles_1m`
  - **Front-month selection**: `FrontMonthTracker` tracks volume per contract in a 5-minute rolling window. Only the highest-volume contract per ticker is used, producing a stitched continuous series (e.g., "ES" from ESH5/ESM5)
  - **Per-second aggregation**: each accepted trade updates the in-progress 1-second candle for its ticker -- price OHLCV, ask/bid volume, CVD OHLC, VD, trade counts, large trade detection
  - **Rolling window**: when a second boundary is crossed, the completed second is stored as a `SecondSummary` in a per-ticker ring buffer. Old entries (>60s) are pruned. The entire ring buffer is then aggregated into a single 1-minute candle.
  - **Warmup period**: no output is written for a ticker until 60 distinct seconds of data have been collected. This ensures the first output row represents a full 60-second window.
  - **Flush cycle** (every 1 second):
    - Stale seconds (current second is behind wall-clock time) are finalized
    - Pending 1-minute rolling candles are written to `candles_1m`
  - **CVD continuity**: on startup, loads the latest `cvd_close` per ticker from `candles_1m` (falls back to `candles_1s`) so CVD is continuous across restarts

- **`tbbo-aggregator.ts`** (legacy) -- the original 1-second aggregator that wrote to `candles_1s`. Kept for reference but no longer used by the live stream.

- **`types.ts`** and **`utils.ts`** re-export types and utilities from `src/lib/trade/` and `src/lib/metrics/`

## Configuration

Environment variables (all required):

| Variable | Example | Description |
|---|---|---|
| `DATABENTO_API_KEY` | `db-abc...xyz` | Databento API key |
| `DATABENTO_DATASET` | `GLBX.MDP3` | Exchange dataset (CME Globex) |
| `DATABENTO_SYMBOLS` | `ES.FUT,NQ.FUT` | Comma-separated symbols |
| `DATABENTO_STYPE` | `parent` | Symbol type: `parent` or `raw_symbol` |
| `DATABASE_URL` | `postgres://...` | PostgreSQL/TimescaleDB connection |

## Shared Libraries

The aggregator is intentionally thin. All core logic is in shared libraries so that historical batch ingestion (`scripts/ingest/tbbo-1m-1s.ts`) and live streaming produce identical results:

- **`src/lib/trade/`** -- Candle aggregation, CVD OHLC tracking, front-month contract selection, trade side detection (Lee-Ready), database writer, timestamp bucketing
- **`src/lib/metrics/`** -- Volume delta calculation, order flow metrics

The stream-specific code only handles: TCP connection, Databento protocol, JSON parsing, market-hours gating, and the flush timer.

## CVD Continuity

On startup, the aggregator queries `candles_1m` (falling back to `candles_1s`) for the latest `cvd_close` per ticker. This ensures CVD is continuous across server restarts. If the tables are empty or unreachable, CVD starts from 0.
