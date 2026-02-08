# Market data

## Storage

Storing TBBO and OHLCV financial time series data for futures contracts and crypto, in multiple timeframes. This will be served to the client-side for charting and visualizing next to technical analysis and trading strategy backtesting results.

## Analysis

Each timeframe will have calculated indicator algorithm values, such as RSI, CVD, OBV, etc. This will be used for technial analysis and trading strategy development.

## Back-testing

The goal of this project is to create a unique platform for back-testing trading stragies. Unlike other products, this will allow the user to run their custom strategy on multiple timeframes from small (1-second) to large (1-day), at high resolution. The strategy must have confluence in all timeframes (trigger on 1-second, 1-minute, 1-hour, and any custom timeframes such as 59-minute or 181-minute).

The indicator values will all be calculated at the lowest possible timeframe. This is the main differentiator. Other platforms calculate and save the 60-minute indicator values every 60-minutes, but this will calculate and save all higher timeframes at 1-minute resolution. Even the 1-day timeframe indicator and starategy values will be calculated and saved every 1-minute.

For 1-second (and sub-minute timeframes derived from 1-second, such as 5-seconds, 10-seconds, 30-seconds), the indicator values will be calculated every 1-second. That is a further advantage, letting the user write a very precise strategy, while still being able to reference large timeframes such as 1-hour to 1-day without waiting for them to finish.

## Rolling-window sampling pre-processing

The way to accomplish this multi-timeframe analysis at high resolution, is a very unique technique which no other app does.

For example, to calculate high/low or RSI/EMA of a 180-minute timeframe, we'll always use 1-minute as the source of truth:

Instead of calculating a 180-minute timeframe every 180 minutes, we will pre-process it, calculate a new candle value for it every 1-minute. It will be a rolling-window / sliding-window sampling calculation. We will remember the previous 180-minutes in memory at all times. Instead of having 1 closing candle value, it will have 180 closing candle values, one for every minute.

For previous candles, we'll need to query the previous closing values for every unique minute in that 180-minute range. So if right now is minute_index 178, we'll select historical values with minute_index 178 (not calendar time, but the index of the current timeframe being analyzed).

For this example, to calculate RSI 14 period, we'll need 14 rows from the `ohlcv_180m` where `minute_index=178`. This 178 is the current minute index in the current timeframe. So, `select from ohlcv_180m where symbol=$current_symbol and minute_index=$current_minute`.

## Documentation

Search and read ./docs folder for more information, important context and example scripts.

@docs
