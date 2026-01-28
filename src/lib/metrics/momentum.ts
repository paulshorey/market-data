/**
 * Momentum Metrics: vd_strength
 *
 * Shows if pressure is accelerating or exhausting by comparing
 * current VD to recent historical VD.
 */

/** Number of candles to track for rolling momentum calculations */
export const MOMENTUM_WINDOW = 5;

/**
 * Momentum tracker for calculating VD strength over a rolling window
 */
export class MomentumTracker {
  /** Rolling VD history per ticker for momentum calculations (most recent last) */
  private vdHistoryByTicker: Map<string, number[]> = new Map();

  /**
   * Update rolling VD history for a ticker (keeps last MOMENTUM_WINDOW values)
   *
   * @param ticker - The ticker symbol
   * @param vd - The volume delta for this candle
   */
  updateVdHistory(ticker: string, vd: number): void {
    const history = this.vdHistoryByTicker.get(ticker) || [];
    history.push(vd);

    // Keep only the last MOMENTUM_WINDOW values
    if (history.length > MOMENTUM_WINDOW) {
      history.shift();
    }

    this.vdHistoryByTicker.set(ticker, history);
  }

  /**
   * Get rolling VD metrics for momentum calculation
   *
   * @param ticker - The ticker symbol
   * @param currentVd - The current candle's VD
   * @returns { vdSma: average VD, vdStrength: current VD relative to average }
   */
  getVdMomentum(ticker: string, currentVd: number): { vdSma: number; vdStrength: number } {
    const history = this.vdHistoryByTicker.get(ticker) || [];

    if (history.length === 0) {
      // No history yet, return neutral values
      return { vdSma: currentVd, vdStrength: 1 };
    }

    // Calculate simple moving average of recent VD
    const vdSma = history.reduce((sum, v) => sum + v, 0) / history.length;

    // Calculate strength: how current VD compares to recent average
    // Use absolute values to compare magnitude, then apply sign
    const avgAbsVd = history.reduce((sum, v) => sum + Math.abs(v), 0) / history.length;

    if (avgAbsVd === 0) {
      // No recent activity, current VD is the signal
      return { vdSma: 0, vdStrength: currentVd !== 0 ? 2 : 1 };
    }

    // vdStrength > 1 means current pressure is stronger than recent average
    // vdStrength < 1 means current pressure is weaker than recent average
    // Sign indicates if it's in same direction as recent trend
    const vdStrength = Math.abs(currentVd) / avgAbsVd;

    return { vdSma, vdStrength };
  }

  /**
   * Get the VD history for a ticker (for testing/debugging)
   */
  getHistory(ticker: string): number[] {
    return this.vdHistoryByTicker.get(ticker) || [];
  }

  /**
   * Clear history for a ticker
   */
  clearHistory(ticker: string): void {
    this.vdHistoryByTicker.delete(ticker);
  }

  /**
   * Clear all history
   */
  clearAll(): void {
    this.vdHistoryByTicker.clear();
  }
}
