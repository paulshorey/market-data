# Market Data back-end

This NodeJS app will run continuously, polling APIs every 10 seconds for new futures and crypto prices and statistics. It will filter, aggregate and format the data, and save the analysis to our own database.

It will also serve the aggregated formatted data via APIs for use by web apps and bots.

## Hosting Platform

[Railway](https://railway.com)

Documentation about Railway is available locally in this codebase, inside the "docs" folder. When you need to know how to configure or deploy something, read the many .md files inside ./docs folder.

## API Endpoints

- `GET /health` - Health check for Railway
- `GET /tables` - Database schema information
- `GET /historical/candles?start=<ms>&end=<ms>&ticker=<required>` - OHLCV candle data (returns `[timestamp_ms, open, high, low, close, volume]` tuples for Highcharts compatibility; order flow metrics vd/cvd/momentum not included)
- `GET /historical/range` - Available date range in database

## Database Tables

TimescaleDB with candle tables per timeframe:
- `candles-1m` (note: uses dash, not underscore)
- `candles_1h`
- `candles_1d`
- `candles_1w`

Base columns (all timeframes): time (ISO), ticker, symbol, open, high, low, close, volume

Additional columns on `candles-1m` only: vd, cvd, momentum

## Order Flow Metrics

Order flow analysis from TBBO (Trade by Best Bid/Offer) data:

- **VD (Volume Delta)**: `askVolume - bidVolume` per candle
  - Positive = more aggressive buying (bullish pressure)
  - Negative = more aggressive selling (bearish pressure)

- **CVD (Cumulative Volume Delta)**: Running sum of VD
  - Tracks cumulative aggressor activity over time
  - Divergence from price indicates potential reversal

- **Momentum**: `(close - open) / |vd|` (price efficiency)
  - Measures how much price moved per unit of aggressive volume
  - High magnitude = efficient price movement
  - Low magnitude with high |VD| = **absorption** (accumulation/distribution)
  - Used to detect areas where aggressive orders are being absorbed by limit orders
  - When `VD = 0` (no aggressor imbalance), momentum is stored as `NULL` (mathematically undefined)

## Code Structure

TypeScript with ES Modules. Uses `tsx` to run directly without build step.

- `src/index.ts` - Express server and route handlers
- `src/lib/db.ts` - Database connection pool
- `src/lib/schema.ts` - Schema introspection queries
- `src/lib/candles.ts` - Candle queries with automatic timeframe selection
- `scripts/import-databento.js` - Data import script (CommonJS)

## Timeframe Selection

The `/historical/candles` endpoint automatically selects the best timeframe based on the requested date range. It targets ~400 candles per response for optimal chart density. Smaller timeframes are preferred when possible.
