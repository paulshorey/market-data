# Technical Analysis Libraries for Pivot Detection

> **Status:** Research notes. None of these libraries are used in the codebase yet. See [high-low-detection.md](./high-low-detection.md) for a concise summary.

**Python with a combined stack of TA-Lib, scipy.signal, and VectorBT delivers the optimal solution** for building a custom backtesting tool with pivot prediction capabilities. TA-Lib provides unmatched cycle analysis through its Hilbert Transform suite, scipy.signal offers flexible peak detection algorithms, and VectorBT delivers the fastest vectorized backtesting with built-in pivot detection. This combination addresses all five requirements—pivot detection, timing analysis, trajectory analysis, and custom indicator development—while maintaining production-grade performance.

## Why Python dominates this use case

Python emerges as the clear winner for three critical reasons: **ecosystem breadth**, **performance tooling**, and **community support**. While R excels at statistical rigor and Julia offers raw speed, Python's library ecosystem specifically addresses the pivot detection and cycle analysis requirements with ready-to-use implementations. The language supports both exploratory research (pandas-ta, backtrader) and production deployment (VectorBT with Numba JIT compilation).

The key insight from this research is that **no single library handles everything**. The optimal approach combines specialized tools: TA-Lib for cycle indicators, scipy for signal processing, and VectorBT for high-speed backtesting. Libraries attempting to be comprehensive (like zipline or backtrader) sacrifice either performance or feature depth.

## Pivot point detection: the core algorithms

Three methods stand out for detecting swing highs and lows programmatically, each with distinct trade-offs between speed and accuracy.

**Scipy's `find_peaks` function** provides the most flexible approach, offering parameters for prominence, distance, height, and width filtering. This signal processing method works on any numerical array and integrates cleanly with pandas DataFrames:

```python
from scipy.signal import find_peaks
import numpy as np

def detect_pivots(df, prominence=None, distance=5):
    """Detect swing highs and lows using signal processing."""
    peaks_high, _ = find_peaks(df['high'].values,
                                prominence=prominence, distance=distance)
    peaks_low, _ = find_peaks(-df['low'].values,
                               prominence=prominence, distance=distance)
    return peaks_high, peaks_low
```

**Williams Fractals** offer a rule-based alternative requiring 5 bars—the middle bar must be the highest (bearish fractal) or lowest (bullish fractal) compared to 2 bars on each side. Backtrader includes this natively via `bt.indicators.Fractal`, while stock-indicators provides `get_fractal(quotes, 5)`. The 2-bar confirmation delay prevents repainting but sacrifices early detection.

**Rolling window extrema detection** provides customizable sensitivity through adjustable lookback periods. Smaller windows (2-3 bars) generate more signals with higher false positive rates; larger windows (10+ bars) produce fewer, more reliable pivots suitable for swing trading:

```python
def detect_swing_points(df, left_bars=5, right_bars=5):
    """Universal swing detection using rolling comparison."""
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

The repainting problem—where zigzag indicators redraw as price continues—has no perfect solution. Non-repainting versions simply delay signals until confirmation. **Momentum-based confirmation** (using MACD or RSI reversals to lock in pivots) offers the best balance between timeliness and reliability.

## Cycle analysis and timing: measuring wavelengths between pivots

**TA-Lib stands alone** with the only comprehensive Hilbert Transform implementation for financial data. Its cycle indicators—`HT_DCPERIOD` (Dominant Cycle Period), `HT_DCPHASE` (Phase), `HT_SINE` (Sine Wave), and `HT_TRENDMODE`—directly address the timing analysis requirements:

```python
import talib

# Dominant cycle detection
dc_period = talib.HT_DCPERIOD(close)      # Current dominant cycle length
dc_phase = talib.HT_DCPHASE(close)        # Where we are in the cycle
sine, leadsine = talib.HT_SINE(close)     # Cycle visualization
trend_mode = talib.HT_TRENDMODE(close)    # 1=trending, 0=cycling

# MESA Adaptive Moving Average (adapts to cycle)
mama, fama = talib.MAMA(close, fastlimit=0.5, slowlimit=0.05)
```

For calculating wavelengths between pivots and comparing to historical averages, combine pivot detection with statistical analysis:

```python
import numpy as np

def wavelength_timing_analysis(pivot_indices, current_bar):
    """Compare current distance from last pivot to historical averages."""
    wavelengths = np.diff(pivot_indices)
    avg_wavelength = np.mean(wavelengths)
    std_wavelength = np.std(wavelengths)

    current_distance = current_bar - pivot_indices[-1]
    z_score = (current_distance - avg_wavelength) / std_wavelength

    return {
        'historical_avg': avg_wavelength,
        'current_distance': current_distance,
        'z_score': z_score,  # >1 = overextended timing
        'expected_remaining': max(0, avg_wavelength - current_distance)
    }
```

**Wavelet analysis** (via PyWavelets) provides time-frequency localization that FFT lacks—critical for financial data where cycle parameters shift. **Empirical Mode Decomposition** (EMD library) adaptively extracts cycle components without predefined basis functions:

```python
import emd

def adaptive_cycle_extraction(price_data):
    """Extract cycles using EMD + Hilbert transform."""
    imf = emd.sift.sift(price_data)
    IP, IF, IA = emd.spectra.frequency_transform(imf, 1, 'hilbert')
    # Each IMF represents different cycle component
    return imf, IF
```

**Tindicators** deserves special mention for implementing **161 indicators** including the complete John Ehlers collection: MAMA/FAMA, Homodyne Discriminator, Mesa Sine Wave, SuperSmoother, Roofing Filter, and various Butterworth/Gaussian filters.

## Price trajectory and pattern recognition

For trendline analysis connecting sequential pivots, **trendln** provides automated support/resistance detection with multiple algorithms including Hough transform:

```python
import trendln

# Automatic trendline detection
support, resistance = trendln.calc_support_resistance(
    df['close'].values,
    accuracy=10
)
```

**PatternPy** handles chart pattern recognition (Head & Shoulders, triangles, double tops) with vectorized high-speed implementation. For harmonic patterns (Gartley, Bat, Butterfly, Crab), the **HarmonicPatterns** GitHub library validates zigzag patterns against Fibonacci ratios and includes prediction mode for projecting reversal zones.

Elliott Wave analysis remains challenging—**taew** on PyPI provides both Traditional and Alternative labeling with Fibonacci validation, while **ElliottWaveAnalyzer** implements rule-based wave validation (wave 3 not shortest, wave 4 no overlap with wave 1).

## Library comparison matrix

| Library              | Pivot Detection |  ZigZag   | Cycle Analysis | Custom Indicators | Performance | Maintenance |
| -------------------- | :-------------: | :-------: | :------------: | :---------------: | :---------: | :---------: |
| **TA-Lib**           |       ❌        |    ❌     |     ✅✅✅     |        ❌         |    ✅✅     |     ✅      |
| **scipy.signal**     |     ✅✅✅      |    ✅     |       ✅       |      ✅✅✅       |    ✅✅     |     ✅      |
| **VectorBT**         |      ✅✅       |    ✅     |   via TA-Lib   |      ✅✅✅       |   ✅✅✅    |     ✅      |
| **pandas-ta**        |       ✅        |    ❌     |       ✅       |       ✅✅        |    ✅✅     |     ✅      |
| **Backtrader**       |       ❌        | community |   via TA-Lib   |      ✅✅✅       |     ❌      |     ⚠️      |
| **tindicators**      |       ❌        |    ❌     |     ✅✅✅     |        ✅         |    ✅✅     |     ✅      |
| **stock-indicators** |       ✅        |    ✅     |       ✅       |        ❌         |     ✅      |     ✅      |

**VectorBT** delivers the fastest backtesting—filling **1,000,000 orders in 70-100ms** through Numba JIT compilation. Its IndicatorFactory enables custom indicator development with automatic vectorization. The PRO version includes non-repainting zigzag and pivot detection, though the open-source version integrates with TA-Lib and pandas-ta for these features.

**Backtrader** offers the most flexible framework for custom indicator development and includes built-in Williams Fractals, but its event-driven architecture sacrifices performance. Development appears stalled (last major update 2020), making it better suited for prototyping than production.

## R and alternative languages

**R's TTR package** includes both `ZigZag()` and `pivots()` functions—the only ecosystem with both built-in. Combined with **WaveletComp** for sophisticated wavelet-based cycle analysis, R provides superior statistical validation capabilities. However, Python wins on production deployment and ecosystem breadth.

**Pine Script** offers the easiest pivot detection via `ta.pivothigh()` and `ta.pivotlow()`, but platform lock-in (TradingView only), execution timeouts, and inability to import external libraries make it unsuitable for custom backtesting tools.

**Julia** offers 3-5x performance gains via MarketTechnicals.jl and TALib.jl wrapper, but the smaller ecosystem means implementing pivot detection and cycle analysis from scratch.

## Recommended implementation stack

For building a comprehensive pivot prediction backtesting tool, implement this layered architecture:

```python
# Core stack installation
# pip install TA-Lib scipy vectorbt pandas-ta emd PyWavelets stock-indicators

import talib
import vectorbt as vbt
import pandas_ta as ta
from scipy.signal import find_peaks
from stock_indicators import indicators

# Layer 1: Pivot Detection (scipy + stock-indicators)
peaks, _ = find_peaks(df['high'], prominence=atr*0.5, distance=5)
zigzag = indicators.get_zig_zag(quotes, EndType.HIGH_LOW, percent_change=5)

# Layer 2: Cycle Analysis (TA-Lib)
dominant_period = talib.HT_DCPERIOD(close)
trend_mode = talib.HT_TRENDMODE(close)

# Layer 3: Wavelength Statistics
wavelengths = np.diff(pivot_indices)
z_score = (current_distance - np.mean(wavelengths)) / np.std(wavelengths)

# Layer 4: Backtesting (VectorBT)
pf = vbt.Portfolio.from_signals(close, entries, exits)
```

This combination provides **comprehensive pivot detection** (scipy flexibility + stock-indicators zigzag), **best-in-class cycle analysis** (TA-Lib Hilbert suite), **statistical timing analysis** (wavelength comparisons), and **production-grade backtesting** (VectorBT performance).

## Conclusion

**Python with TA-Lib + scipy.signal + VectorBT** represents the optimal combination for this specific use case. TA-Lib's Hilbert Transform suite is irreplaceable for cycle analysis—no other library provides equivalent functionality. Scipy's signal processing tools offer the most flexible pivot detection with parameters for prominence, distance, and noise filtering. VectorBT's Numba-powered backtesting handles the computational demands of testing pivot prediction strategies across large datasets.

The critical insight: **pivot prediction remains fundamentally limited** by the retrospective nature of price action. The most effective approach combines multiple confirmation methods—cycle timing (is price "due" for a reversal based on historical wavelengths?), trajectory alignment (does current price intersect trendlines connecting prior pivots?), and pattern completion (are harmonic or Elliott wave targets being reached?). Building probabilistic models that aggregate these signals provides more reliable predictions than any single indicator.

For those requiring R's statistical rigor, TTR + WaveletComp + PerformanceAnalytics provides an excellent research environment, with results ported to Python for production deployment. For rapid prototyping, tindicators' comprehensive Ehlers indicator collection accelerates development of cycle-based strategies.
