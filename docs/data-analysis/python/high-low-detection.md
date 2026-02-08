# Pivot Detection Methods

Research on detecting swing highs and lows programmatically, for use in timing analysis and trajectory prediction.

**Implementation status:** This is research/planning. No pivot detection is implemented in the codebase yet.

## The Problem

Detecting if the current price is at a pivot high or low requires looking forward -- a pivot isn't confirmed until price moves away from it. The challenge is balancing early detection (useful for trading) against false positives (repainting).

## Three Core Methods

### 1. scipy's `find_peaks`

Most flexible approach. Works on any numerical array with configurable prominence, distance, and height filtering.

```python
from scipy.signal import find_peaks

def detect_pivots(df, prominence=None, distance=5):
    peaks_high, _ = find_peaks(df['high'].values,
                                prominence=prominence, distance=distance)
    peaks_low, _ = find_peaks(-df['low'].values,
                               prominence=prominence, distance=distance)
    return peaks_high, peaks_low
```

### 2. Williams Fractals

Rule-based: the middle bar of 5 must be the highest (bearish fractal) or lowest (bullish fractal) compared to 2 bars on each side. Available in Backtrader (`bt.indicators.Fractal`) and stock-indicators (`get_fractal(quotes, 5)`).

2-bar confirmation delay prevents repainting but sacrifices early detection.

### 3. Rolling Window Extrema

Adjustable sensitivity via lookback period. Smaller windows (2-3 bars) = more signals, more false positives. Larger windows (10+) = fewer, more reliable pivots.

```python
def detect_swing_points(df, left_bars=5, right_bars=5):
    high, low = df['high'], df['low']
    swing_high = (
        (high >= high.rolling(left_bars).max().shift(1)) &
        (high >= high.rolling(right_bars).max().shift(-right_bars))
    )
    swing_low = (
        (low <= low.rolling(left_bars).min().shift(1)) &
        (low <= low.rolling(right_bars).min().shift(-right_bars))
    )
    return swing_high, swing_low
```

## The Repainting Problem

Zigzag indicators redraw as price continues. No perfect solution exists. Non-repainting versions simply delay signals until confirmation. Momentum-based confirmation (MACD or RSI reversals to lock in pivots) offers the best balance.

## Two-Axis Prediction Approach

### X-axis (Timing)
Calculate a running average of wavelength (distance in bars) between recent swing highs/lows. Compare to the current distance from last pivot. If the current distance approaches the historical average, there's higher probability of a new pivot forming.

See [scripts/pivot-timing-analysis.py](./scripts/pivot-timing-analysis.py) for implementation using scipy + TA-Lib Hilbert Transform.

### Y-axis (Trajectory)
Compare current price to the trajectory of previous pivots. If recent lows are at 100, 102, 104 and current price is at 106, that linear alignment increases the probability of being at a pivot.

See [scripts/pivot-trajectory-analysis.py](./scripts/pivot-trajectory-analysis.py) for implementation using linear regression on pivot sequences.

## Recommended Stack

| Requirement | Tool |
|-------------|------|
| Pivot detection | `scipy.signal.find_peaks()` |
| X-axis timing/cycles | TA-Lib Hilbert Transform (`HT_DCPERIOD`, `HT_DCPHASE`) |
| Y-axis trajectory | Custom linear regression |
| Backtesting | VectorBT (1M orders in ~100ms via Numba JIT) |

No single library handles all of these. The trajectory alignment concept doesn't exist in any library and must be built custom.
