## Example of a JSONL file from Databento:

A file like this will be processed by historical-tbbo.ts script. The real file will be much much larger, will need to be read in chunks!
Notice this is not a valid JSON file. It is a text list of JSON objects.

```
{"ts_recv":"2025-11-30T23:00:00.039353882Z","hd":{"ts_event":"2025-11-30T23:00:00.000000000Z","rtype":1,"publisher_id":1,"instrument_id":42140878},"action":"T","side":"N","depth":0,"price":"6913.500000000","size":1,"flags":0,"ts_in_delta":13803,"sequence":3353,"levels":[{"bid_px":"6915.750000000","ask_px":"6913.000000000","bid_sz":1,"ask_sz":1,"bid_ct":1,"ask_ct":1}],"symbol":"ESH6"}
{"ts_recv":"2025-11-30T23:00:00.039411041Z","hd":{"ts_event":"2025-11-30T23:00:00.000000000Z","rtype":1,"publisher_id":1,"instrument_id":294973},"action":"T","side":"N","depth":0,"price":"6854.750000000","size":84,"flags":0,"ts_in_delta":14448,"sequence":3354,"levels":[{"bid_px":"6875.000000000","ask_px":"6820.000000000","bid_sz":9,"ask_sz":8,"bid_ct":1,"ask_ct":1}],"symbol":"ESZ5"}
{"ts_recv":"2025-11-30T23:00:00.041192999Z","hd":{"ts_event":"2025-11-30T23:00:00.000000000Z","rtype":1,"publisher_id":1,"instrument_id":42007065},"action":"T","side":"N","depth":0,"price":"58.750000000","size":1,"flags":0,"ts_in_delta":13932,"sequence":3355,"levels":[{"bid_px":"58.750000000","ask_px":"58.750000000","bid_sz":1,"ask_sz":1,"bid_ct":1,"ask_ct":1}],"symbol":"ESZ5-ESH6"}
```
