"""
Pivot Trajectory Analysis: Y-Axis Price Alignment
Compares current price to trendline of previous pivots to estimate pivot probability
"""
import numpy as np
from scipy.signal import find_peaks
from scipy import stats
from dataclasses import dataclass
from typing import List, Tuple, Optional


@dataclass
class PivotPoint:
    index: int
    price: float
    is_high: bool


def detect_pivots_with_prices(highs: np.ndarray, lows: np.ndarray, 
                               distance: int = 5) -> List[PivotPoint]:
    """Detect pivots and return with price levels."""
    peak_idx, _ = find_peaks(highs, distance=distance)
    valley_idx, _ = find_peaks(-lows, distance=distance)
    
    pivots = []
    for idx in peak_idx:
        pivots.append(PivotPoint(idx, highs[idx], is_high=True))
    for idx in valley_idx:
        pivots.append(PivotPoint(idx, lows[idx], is_high=False))
    
    return sorted(pivots, key=lambda p: p.index)


def fit_pivot_trendline(pivots: List[PivotPoint], is_high: bool, 
                        lookback: int = 5) -> Optional[Tuple[float, float, float]]:
    """
    Fit a linear trendline through recent pivot highs or lows.
    Returns (slope, intercept, r_squared) or None if insufficient data.
    """
    # Filter to only highs or lows
    filtered = [p for p in pivots if p.is_high == is_high][-lookback:]
    
    if len(filtered) < 2:
        return None
    
    x = np.array([p.index for p in filtered])
    y = np.array([p.price for p in filtered])
    
    slope, intercept, r_value, _, _ = stats.linregress(x, y)
    
    return slope, intercept, r_value ** 2


def trajectory_alignment_analysis(pivots: List[PivotPoint], 
                                   current_bar: int, 
                                   current_high: float,
                                   current_low: float,
                                   tolerance_pct: float = 0.5):
    """
    Y-AXIS ANALYSIS: Check if current price aligns with pivot trajectory.
    
    Your example: "If recently there was a low and then another low two points 
    higher than that, and the current price is two points higher than that, 
    that is higher probability that we're at the next pivot low."
    
    This generalizes that concept using linear regression on pivot sequences.
    """
    results = {}
    
    # Analyze swing highs trajectory
    high_trend = fit_pivot_trendline(pivots, is_high=True)
    if high_trend:
        slope, intercept, r_squared = high_trend
        projected_high = slope * current_bar + intercept
        deviation_pct = abs(current_high - projected_high) / projected_high * 100
        
        results['swing_high'] = {
            'slope': slope,
            'r_squared': r_squared,
            'projected_price': projected_high,
            'current_price': current_high,
            'deviation_pct': deviation_pct,
            'aligned': deviation_pct <= tolerance_pct,
            'trend_direction': 'ascending' if slope > 0 else 'descending',
            # Higher r² + lower deviation = higher probability
            'alignment_score': r_squared * max(0, 1 - deviation_pct / tolerance_pct)
        }
    
    # Analyze swing lows trajectory
    low_trend = fit_pivot_trendline(pivots, is_high=False)
    if low_trend:
        slope, intercept, r_squared = low_trend
        projected_low = slope * current_bar + intercept
        deviation_pct = abs(current_low - projected_low) / projected_low * 100
        
        results['swing_low'] = {
            'slope': slope,
            'r_squared': r_squared,
            'projected_price': projected_low,
            'current_price': current_low,
            'deviation_pct': deviation_pct,
            'aligned': deviation_pct <= tolerance_pct,
            'trend_direction': 'ascending' if slope > 0 else 'descending',
            'alignment_score': r_squared * max(0, 1 - deviation_pct / tolerance_pct)
        }
    
    return results


def combined_pivot_probability(timing_analysis: dict, 
                                trajectory_analysis: dict,
                                check_high: bool = True) -> dict:
    """
    Combine X-axis timing and Y-axis trajectory for overall pivot probability.
    
    This is the core of your predictive model:
    - High timing probability + high trajectory alignment = likely pivot
    """
    key = 'swing_high' if check_high else 'swing_low'
    
    if key not in trajectory_analysis or timing_analysis is None:
        return {'probability': 0, 'confidence': 'low', 'reason': 'insufficient data'}
    
    timing_prob = timing_analysis['timing_probability']
    alignment_score = trajectory_analysis[key]['alignment_score']
    
    # Weighted combination (you can tune these weights)
    # Timing matters more early in development, trajectory more in confirmation
    combined_prob = (timing_prob * 0.4 + alignment_score * 0.6)
    
    # Confidence based on data quality
    r_squared = trajectory_analysis[key]['r_squared']
    if r_squared > 0.8 and timing_prob > 0.6:
        confidence = 'high'
    elif r_squared > 0.5 and timing_prob > 0.4:
        confidence = 'medium'
    else:
        confidence = 'low'
    
    return {
        'probability': combined_prob,
        'confidence': confidence,
        'timing_contribution': timing_prob,
        'trajectory_contribution': alignment_score,
        'trajectory_r_squared': r_squared,
        'is_aligned': trajectory_analysis[key]['aligned'],
        'projected_price': trajectory_analysis[key]['projected_price']
    }


# Example demonstrating your specific scenario
if __name__ == "__main__":
    print("=== Y-AXIS: Trajectory Alignment Analysis ===\n")
    
    # Your example scenario:
    # "If recently there was a low and then another low two points higher,
    #  and current price is two points higher than that"
    
    # Simulating: lows at 100, 102, and current at 104
    example_pivots = [
        PivotPoint(index=10, price=105, is_high=True),
        PivotPoint(index=20, price=100, is_high=False),  # First low
        PivotPoint(index=30, price=108, is_high=True),
        PivotPoint(index=40, price=102, is_high=False),  # Second low (+2)
        PivotPoint(index=50, price=110, is_high=True),
    ]
    
    current_bar = 60
    current_low = 104  # Exactly +2 from last low - should align!
    current_high = 109
    
    trajectory = trajectory_alignment_analysis(
        example_pivots, current_bar, current_high, current_low, tolerance_pct=1.0
    )
    
    print("Scenario: Ascending lows at 100, 102, current price 104")
    print(f"\nSwing Low Trajectory:")
    print(f"  Trend: {trajectory['swing_low']['trend_direction']}")
    print(f"  Projected low: {trajectory['swing_low']['projected_price']:.2f}")
    print(f"  Current low: {trajectory['swing_low']['current_price']:.2f}")
    print(f"  Deviation: {trajectory['swing_low']['deviation_pct']:.2f}%")
    print(f"  Aligned: {trajectory['swing_low']['aligned']}")
    print(f"  R-squared: {trajectory['swing_low']['r_squared']:.3f}")
    print(f"  Alignment score: {trajectory['swing_low']['alignment_score']:.3f}")
    
    # Simulated timing analysis (would come from wavelength_timing_analysis)
    mock_timing = {'timing_probability': 0.75}
    
    print("\n=== COMBINED PROBABILITY ===")
    combined = combined_pivot_probability(mock_timing, trajectory, check_high=False)
    print(f"  Overall probability: {combined['probability']:.2%}")
    print(f"  Confidence: {combined['confidence']}")
    print(f"  Timing contribution: {combined['timing_contribution']:.2%}")
    print(f"  Trajectory contribution: {combined['trajectory_contribution']:.3f}")