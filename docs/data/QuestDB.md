# Overview

This is defunct, not used. No QuestDB connected. This documentation is only for historical and future use.

This app uses QuestDB flavor of Postgres
Connection URL is same as connecting to Postgres
To connect to the DB, use environment varibale `QDB_PG_URL` in .env file

## Created QuestDB timeseries table for 1-minute rows

CREATE TABLE 'futures-ohlcv' (minute TIMESTAMP) timestamp (minute) PARTITION BY MONTH WAL;

ALTER TABLE 'futures-ohlcv' ADD COLUMN open DOUBLE;
ALTER TABLE 'futures-ohlcv' ADD COLUMN high DOUBLE;
ALTER TABLE 'futures-ohlcv' ADD COLUMN low DOUBLE;
ALTER TABLE 'futures-ohlcv' ADD COLUMN close DOUBLE;
ALTER TABLE 'futures-ohlcv' ADD COLUMN volume LONG;
ALTER TABLE 'futures-ohlcv' ADD COLUMN ticker SYMBOL;

## Table: `futures-ohlcv`

### Purpose

Stores 1-minute OHLCV candlestick data for futures contracts.

### Schema

| Column | Type      | Nullable | Description                                |
| ------ | --------- | -------- | ------------------------------------------ |
| minute | TIMESTAMP | NO       | Candle open time (designated timestamp)    |
| open   | DOUBLE    | YES      | Opening price                              |
| high   | DOUBLE    | YES      | Highest price during interval              |
| low    | DOUBLE    | YES      | Lowest price during interval               |
| close  | DOUBLE    | YES      | Closing price                              |
| volume | LONG      | YES      | Number of contracts traded                 |
| ticker | SYMBOL    | YES      | Futures contract symbol (e.g., 'ES', 'NQ') |

### Configuration

- **Designated timestamp:** `minute`
- **Partition by:** `MONTH`
- **Write mode:** `WAL`

### Example Queries

```sql
-- Latest candle per ticker
SELECT * FROM 'futures-ohlcv' LATEST ON minute PARTITION BY ticker;

-- Daily OHLCV aggregation
SELECT
  ticker,
  first(open) as open,
  max(high) as high,
  min(low) as low,
  last(close) as close,
  sum(volume) as volume
FROM 'futures-ohlcv'
WHERE minute IN '2024-01-15'
GROUP BY ticker;
```
