# Databento

A web service which provides live and historical futures market data.

Historical API: https://databento.com/docs/api-reference-historical?historical=http&live=http&reference=http

## Historical data

For historical data, I will download and save the data manually, one file per instrument.
Then run a node script to process each downloaded data file.

Saved `ES` ticker history to file:
/absolute-path-in-computer/ES-20251230-full-history-OHLCV.txt

This file contains a new JS object on every new line. It is not a full formatted JSON file.
Each line in the file looks like this. Each 1-minute ohlcv JSON object is separated by a new line.

```
{"hd":{"ts_event":"2010-06-06T22:03:00.000000000Z","rtype":33,"publisher_id":1,"instrument_id":6640},"open":"1064.000000000","high":"1064.500000000","low":"1063.500000000","close":"1064.000000000","volume":"589","symbol":"ESM0"}
```

We'll need a standalone Node script, run manually, which will read this data file and upload each minute bar to a new row in the database. If that minute timestamp already exists, then update the row with new values read from the file.
