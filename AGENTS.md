# Market Data back-end

This NodeJS app will run continuously, polling APIs every 10 seconds for new futures and crypto prices and statistics. It will filter, aggregate and format the data, and save the analysis to our own database.

It will also serve the aggregated formatted data via APIs for use by web apps and bots.

## Hosting Platform

[Railway](https://railway.com)

Documentation about Railway is available locally in this codebase, inside the "docs" folder. When you need to know how to configure or deploy something, read the many .md files inside ./docs folder.

## API Endpoints

- `GET /health` - Health check for Railway
- `GET /tables` - Database schema information
- `GET /historical/candles?start=<ms>&end=<ms>&ticker=<required>` - OHLCV candle data (returns `[timestamp_ms, open, high, low, close, volume]` tuples for Highcharts compatibility; order flow metrics not included in basic response)
- `GET /historical/range` - Available date range in database

## Database Tables

TimescaleDB with candle tables per timeframe:
- `candles-1m` (note: uses dash, not underscore)
- `candles_1h`
- `candles_1d`
- `candles_1w`

Base columns (all timeframes): time (ISO), ticker, symbol, open, high, low, close, volume

Additional order flow columns on `candles-1m` only: vd, cvd, vd_ratio, price_pct, divergence, evr

## Order Flow Metrics

Order flow analysis from TBBO (Trade by Best Bid/Offer) data. These metrics help detect accumulation, distribution, and absorption zones where large traders are building or exiting positions.

### Core Metrics

- **VD (Volume Delta)**: `askVolume - bidVolume` per candle
  - Positive = more aggressive buying (bullish pressure)
  - Negative = more aggressive selling (bearish pressure)

- **CVD (Cumulative Volume Delta)**: Running sum of VD
  - Tracks cumulative aggressor activity over time
  - Divergence from price indicates potential reversal

### Normalized Metrics (for cross-instrument comparison)

- **VD Ratio**: `VD / (askVolume + bidVolume)` bounded -1 to +1
  - +1 = 100% buy dominance (all volume at ask)
  - -1 = 100% sell dominance (all volume at bid)
  - 0 = balanced buying and selling
  - Most important metric for evaluating imbalance intensity

- **Price Pct**: `((close - open) / open) * 10000` in basis points
  - 100 = 1% price increase
  - Allows cross-instrument comparison (ES at 5000 vs CL at 70)

### Absorption Detection

- **Divergence**: Flag for accumulation/distribution signals
  - `+1` = Bullish divergence: Sellers aggressive (VD < 0) but price UP → accumulation
  - `-1` = Bearish divergence: Buyers aggressive (VD > 0) but price DOWN → distribution
  - `0` = No divergence (price followed aggressor direction)

- **EVR (Effort vs Result)**: `price_pct / (|vd_ratio| * 100)` absorption score
  - `NULL` = No meaningful imbalance (vd_ratio < 5%), EVR not applicable
  - High |EVR| (> 1): Efficient price movement per unit of imbalance
  - Low |EVR| (< 0.5): **Absorption** - aggressive volume absorbed by limit orders
  - EVR ≈ 0 with significant vd_ratio = Strong absorption signal
  - Combined with divergence flag to detect accumulation/distribution zones

## Code Structure

TypeScript with ES Modules. Uses `tsx` to run directly without build step.

- `src/index.ts` - Express server and route handlers
- `src/lib/db.ts` - Database connection pool
- `src/lib/schema.ts` - Schema introspection queries
- `src/lib/candles.ts` - Candle queries with automatic timeframe selection
- `scripts/import-databento.js` - Data import script (CommonJS)

## Timeframe Selection

The `/historical/candles` endpoint automatically selects the best timeframe based on the requested date range. It targets ~400 candles per response for optimal chart density. Smaller timeframes are preferred when possible.
