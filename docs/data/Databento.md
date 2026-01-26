# DataBento

Databento a service which provides live and historical futures market data.

Historical API: https://databento.com/docs/api-reference-historical?historical=http&live=http&reference=http
Live API: https://databento.com/docs/api-reference-live?historical=http&live=http&reference=http
TBBO data: https://databento.com/docs/schemas-and-data-formats/tbbo?historical=http&live=http&reference=http

## Download data file

For historical data, I download the data manually, as one file per instrument:

Saved `ES` ticker history to file:
/absolute-path-in-computer/ES-20251230-full-history-OHLCV.txt

This file contains a new JS object on every new line. It is not a full formatted JSON file.
Each line in the file looks like this. Each 1-minute ohlcv JSON object is separated by a new line.

```
{"hd":{"ts_event":"2010-06-06T22:03:00.000000000Z","rtype":33,"publisher_id":1,"instrument_id":6640},"open":"1064.000000000","high":"1064.500000000","low":"1063.500000000","close":"1064.000000000","volume":"589","symbol":"ESM0"}
```

## Ingest data into our database

We'll need a standalone Node script, run manually, which will read this data file and upload each minute bar to a new row in the database. If that minute timestamp already exists, then update the row with new values read from the file.

## Database

Connection string to our SQL DB is `DATABASE_URL` in `.env`.
Use this in any script to connect to the timeseries database.

Table: `candles-1m`

### Database Schema

```
"tables": {
  "candles-1m": [
    {
      "name": "time",
      "type": "timestamp with time zone",
      "nullable": false,
      "default": null,
      "maxLength": null
    },
    {
      "name": "ticker",
      "type": "text",
      "nullable": false,
      "default": null,
      "maxLength": null
    },
    {
      "name": "open",
      "type": "double precision",
      "nullable": false,
      "default": null,
      "maxLength": null
    },
    {
      "name": "high",
      "type": "double precision",
      "nullable": false,
      "default": null,
      "maxLength": null
    },
    {
      "name": "low",
      "type": "double precision",
      "nullable": false,
      "default": null,
      "maxLength": null
    },
    {
      "name": "close",
      "type": "double precision",
      "nullable": false,
      "default": null,
      "maxLength": null
    },
    {
      "name": "volume",
      "type": "double precision",
      "nullable": false,
      "default": null,
      "maxLength": null
    }
  ]
}
```
