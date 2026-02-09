# Live Streaming Data Processing

Real-time TBBO trade data from Databento, aggregated into 1-second candles and written to the `candles_1s` hypertable. Higher timeframes (1m, 5m, 1h, etc.) are computed automatically by TimescaleDB continuous aggregates.

## How It Works

- **`tbbo-stream.ts`** connects to Databento's Raw TCP API, authenticates, and subscribes to TBBO (Top of Book on Trade) data for configured symbols
  - Parses newline-delimited JSON messages from the socket
  - Builds an instrument_id-to-symbol lookup from symbol mapping messages (rtype=22)
  - Converts trade messages (action="T") into `TbboRecord` objects
  - Skips spread contracts (symbols containing "-") and trades during market closed hours
  - Passes each valid trade to the aggregator

- **`tbbo-aggregator.ts`** collects trades into 1-second candles and writes them to `candles_1s`
  - **Front-month selection**: `FrontMonthTracker` tracks volume per contract in a 5-minute rolling window. Only the highest-volume contract per ticker is used, producing a stitched continuous series (e.g., "ES" from ESH5/ESM5)
  - **Candle aggregation**: each accepted trade updates the in-progress 1-second candle for its ticker -- price OHLCV, ask/bid volume, CVD OHLC, VD, trade counts, large trade detection
  - **Flush cycle** (every 1 second):
    - Completed candles (past seconds): INSERT into `candles_1s`, update CVD totals, remove from memory
    - In-progress candle (current second): UPSERT into `candles_1s`, keep in memory for continued aggregation
  - **CVD continuity**: on startup, loads the latest `cvd_close` per ticker from `candles_1s` so CVD is continuous across restarts

- **`candles_1s`** is the sole source of truth. TimescaleDB continuous aggregates automatically roll it up into `candles_1m`, `candles_5m`, `candles_1h`, `candles_1d` on a schedule (see `docs/data-storage/timescale-aggregators.md`)

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

The aggregator is intentionally thin. All core logic is in shared libraries so that historical batch ingestion (`scripts/ingest/tbbo-1s.ts`) and live streaming produce identical results:

- **`src/lib/trade/`** -- Candle aggregation, CVD OHLC tracking, front-month contract selection, trade side detection (Lee-Ready), database writer, timestamp bucketing
- **`src/lib/metrics/`** -- Volume delta calculation, order flow metrics

The stream-specific code only handles: TCP connection, Databento protocol, JSON parsing, market-hours gating, and the flush timer.

## CVD Continuity

On startup, the aggregator queries `candles_1s` for the latest `cvd_close` per ticker. This ensures CVD is continuous across server restarts. If the table is empty or unreachable, CVD starts from 0.
