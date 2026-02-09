"""
Pivot Timing Analysis: X-Axis Wavelength Comparison
Compares current distance from last pivot to historical average wavelengths
"""
import numpy as np
import talib
from scipy.signal import find_peaks


def detect_pivots(highs: np.ndarray, lows: np.ndarray, 
                  prominence: float = None, distance: int = 5):
    """Detect swing highs and lows using scipy signal processing."""
    peak_indices, _ = find_peaks(highs, prominence=prominence, distance=distance)
    valley_indices, _ = find_peaks(-lows, prominence=prominence, distance=distance)
    return peak_indices, valley_indices


def wavelength_timing_analysis(pivot_indices: np.ndarray, current_bar: int):
    """
    X-AXIS ANALYSIS: Compare current timing to historical wavelengths.
    
    Returns probability estimate that we're "due" for a pivot based on timing.
    """
    if len(pivot_indices) < 3:
        return None
    
    # Calculate historical wavelengths (distances between consecutive pivots)
    wavelengths = np.diff(pivot_indices)
    
    # Statistical measures
    avg_wavelength = np.mean(wavelengths)
    std_wavelength = np.std(wavelengths)
    median_wavelength = np.median(wavelengths)
    
    # Current distance from last pivot
    current_distance = current_bar - pivot_indices[-1]
    
    # Z-score: how many standard deviations from average
    z_score = (current_distance - avg_wavelength) / std_wavelength if std_wavelength > 0 else 0
    
    # Percentile: what % of historical wavelengths were shorter than current distance
    percentile = np.mean(wavelengths <= current_distance) * 100
    
    # Simple probability estimate based on historical distribution
    # Higher percentile = more likely we're at/past typical pivot timing
    timing_probability = min(percentile / 100, 1.0)
    
    return {
        'historical_avg_wavelength': avg_wavelength,
        'historical_std': std_wavelength,
        'historical_median': median_wavelength,
        'current_distance': current_distance,
        'z_score': z_score,
        'percentile': percentile,
        'timing_probability': timing_probability,
        'bars_until_avg': max(0, avg_wavelength - current_distance),
        'recent_wavelengths': wavelengths[-5:].tolist()  # Last 5 for context
    }


def cycle_analysis(close: np.ndarray):
    """
    Use TA-Lib Hilbert Transform for cycle detection.
    This is THE reason to use TA-Lib - no other library has this.
    """
    # Dominant Cycle Period - estimated current cycle length
    dc_period = talib.HT_DCPERIOD(close)
    
    # Dominant Cycle Phase - where we are in the cycle (0-360 degrees)
    dc_phase = talib.HT_DCPHASE(close)
    
    # Sine wave representation of cycle
    sine, leadsine = talib.HT_SINE(close)
    
    # Trend vs Cycle mode (1 = trending, 0 = cycling)
    trend_mode = talib.HT_TRENDMODE(close)
    
    return {
        'dominant_period': dc_period[-1],      # Current estimated cycle length in bars
        'phase': dc_phase[-1],                  # Current phase (0-360)
        'sine': sine[-1],
        'leadsine': leadsine[-1],
        'is_trending': bool(trend_mode[-1]),
        # Cycle suggests reversal when sine crosses leadsine
        'cycle_reversal_signal': (sine[-2] < leadsine[-2]) != (sine[-1] < leadsine[-1])
    }


# Example usage
if __name__ == "__main__":
    # Simulate some price data
    np.random.seed(42)
    n_bars = 200
    close = 100 + np.cumsum(np.random.randn(n_bars) * 0.5)
    high = close + np.abs(np.random.randn(n_bars) * 0.3)
    low = close - np.abs(np.random.randn(n_bars) * 0.3)
    
    # Detect pivots
    peak_idx, valley_idx = detect_pivots(high, low, distance=8)
    
    print("=== X-AXIS: Wavelength Timing Analysis ===")
    print(f"\nDetected {len(peak_idx)} swing highs, {len(valley_idx)} swing lows")
    
    # Analyze timing for swing highs
    current_bar = n_bars - 1
    timing = wavelength_timing_analysis(peak_idx, current_bar)
    
    if timing:
        print(f"\nSwing High Timing:")
        print(f"  Average wavelength: {timing['historical_avg_wavelength']:.1f} bars")
        print(f"  Current distance from last high: {timing['current_distance']} bars")
        print(f"  Z-score: {timing['z_score']:.2f}")
        print(f"  Percentile: {timing['percentile']:.1f}%")
        print(f"  Timing probability: {timing['timing_probability']:.2%}")
        print(f"  Recent wavelengths: {timing['recent_wavelengths']}")
    
    # Cycle analysis
    print("\n=== TA-Lib Cycle Analysis ===")
    cycles = cycle_analysis(close)
    print(f"  Dominant period: {cycles['dominant_period']:.1f} bars")
    print(f"  Current phase: {cycles['phase']:.1f}°")
    print(f"  Is trending: {cycles['is_trending']}")
    print(f"  Cycle reversal signal: {cycles['cycle_reversal_signal']}")