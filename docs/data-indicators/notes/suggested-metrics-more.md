## Rolling window VD ratio ("Normalized CVD")

Sum VD over N bars, divide by sum of volume over N bars. This gives a bounded, comparable metric for "what's the buy/sell imbalance over the last N minutes?" This is essentially what CVD oscillators on TradingView do.

```sql
-- Rolling 10-minute VD ratio (from 1m candles)
SELECT time, ticker,
  SUM(vd) OVER w / NULLIF(SUM(volume) OVER w, 0) AS vd_ratio_10m
FROM candles_1m
WINDOW w AS (PARTITION BY ticker ORDER BY time ROWS BETWEEN 9 PRECEDING AND CURRENT ROW);
```

This gives you a bounded [-1, +1] metric that answers "what's the net imbalance over the last 10 minutes?" -- which is what a `cvd_ratio` would intuitively want to express, but done correctly.
