# Market Data back-end

This NodeJS app will run continuously, polling APIs every 10 seconds for new futures and crypto prices and statistics. It will filter, aggregate and format the data, and save the analysis to our own database.

It will also serve the aggregated formatted data via APIs for use by web apps and bots.

## Hosting Platform

[Railway](https://railway.com)

Documentation about Railway is available locally in this codebase, inside the "docs" folder. When you need to know how to configure or deploy something, read the many .md files inside ./docs folder.

## API Endpoints

- `GET /health` - Health check for Railway
- `GET /tables` - Database schema information
- `GET /historical/candles?start=<ms>&end=<ms>&symbol=<optional>` - OHLCV candle data
- `GET /historical/range` - Available date range in database

## Database Tables

TimescaleDB with candle tables per timeframe:
- `candles-1m` (note: uses dash, not underscore)
- `candles_1h`
- `candles_1d`
- `candles_1w`

Columns: time (ISO), open, high, low, close, volume

## Code Structure

TypeScript with ES Modules. Uses `tsx` to run directly without build step.

- `src/index.ts` - Express server and route handlers
- `src/lib/db.ts` - Database connection pool
- `src/lib/schema.ts` - Schema introspection queries
- `src/lib/candles.ts` - Candle queries with automatic timeframe selection
- `scripts/import-databento.js` - Data import script (CommonJS)

## Timeframe Selection

The `/historical/candles` endpoint automatically selects the best timeframe based on the requested date range. It targets ~400 candles per response for optimal chart density. Smaller timeframes are preferred when possible.
