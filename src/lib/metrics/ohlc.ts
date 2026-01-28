/**
 * OHLC (Open, High, Low, Close) tracking for metrics
 *
 * Similar to price candles, we track the open/high/low/close of each metric
 * within a 1-minute window to capture intra-minute dynamics.
 *
 * - Open: First calculated value in the minute (only set once)
 * - High: Maximum value seen during the minute
 * - Low: Minimum value seen during the minute
 * - Close: Most recent value (continuously updated)
 */

/**
 * OHLC values for a single metric
 */
export interface MetricOHLC {
  /** First value in the minute (set once on first calculation) */
  open: number;
  /** Highest value seen during the minute */
  high: number;
  /** Lowest value seen during the minute */
  low: number;
  /** Most recent value (updated on every calculation) */
  close: number;
}

/**
 * Initialize a new MetricOHLC with the first value
 * @param value - The initial value
 */
export function initMetricOHLC(value: number): MetricOHLC {
  return {
    open: value,
    high: value,
    low: value,
    close: value,
  };
}

/**
 * Update a MetricOHLC with a new value
 * - Open remains unchanged (already set)
 * - High updates if new value is higher
 * - Low updates if new value is lower
 * - Close always updates to new value
 *
 * @param ohlc - Existing OHLC to update
 * @param value - New value to incorporate
 */
export function updateMetricOHLC(ohlc: MetricOHLC, value: number): void {
  ohlc.high = Math.max(ohlc.high, value);
  ohlc.low = Math.min(ohlc.low, value);
  ohlc.close = value;
}

/**
 * OHLC tracking for all order flow metrics
 *
 * Each metric that changes during the minute has OHLC tracking:
 * - Direction: vd, cvd, vdRatio
 * - Confirmation: bookImbalance
 * - Price: vwap, spreadBps, pricePct
 * - Activity: avgTradeSize
 * - Absorption: evr
 * - Composite: smp
 *
 * Note: Some metrics like trades, bigTrades, bigVolume, maxTradeSize are
 * cumulative/max by nature and don't need OHLC tracking. divergence is
 * categorical (-1, 0, 1) and vdStrength requires history, so they use
 * simpler tracking.
 */
export interface MetricsOHLC {
  // Direction metrics
  vd: MetricOHLC;
  cvd: MetricOHLC;
  vdRatio: MetricOHLC;

  // Confirmation metrics
  bookImbalance: MetricOHLC;

  // Price/liquidity metrics
  vwap: MetricOHLC;
  spreadBps: MetricOHLC;
  pricePct: MetricOHLC;

  // Activity metrics
  avgTradeSize: MetricOHLC;

  // Absorption metrics
  evr: MetricOHLC;

  // Composite metrics
  smp: MetricOHLC;

  // These don't need OHLC (cumulative or special)
  // trades, bigTrades, bigVolume - cumulative counts
  // maxTradeSize - already tracking max
  // divergence - categorical (-1, 0, 1)
  // vdStrength - requires rolling history
}

/**
 * Initialize all metric OHLC values from current metric values
 */
export function initAllMetricsOHLC(
  vd: number,
  cvd: number,
  vdRatio: number,
  bookImbalance: number,
  vwap: number,
  spreadBps: number,
  pricePct: number,
  avgTradeSize: number,
  evr: number,
  smp: number
): MetricsOHLC {
  return {
    vd: initMetricOHLC(vd),
    cvd: initMetricOHLC(cvd),
    vdRatio: initMetricOHLC(vdRatio),
    bookImbalance: initMetricOHLC(bookImbalance),
    vwap: initMetricOHLC(vwap),
    spreadBps: initMetricOHLC(spreadBps),
    pricePct: initMetricOHLC(pricePct),
    avgTradeSize: initMetricOHLC(avgTradeSize),
    evr: initMetricOHLC(evr),
    smp: initMetricOHLC(smp),
  };
}

/**
 * Update all metric OHLC values with new metric values
 */
export function updateAllMetricsOHLC(
  ohlc: MetricsOHLC,
  vd: number,
  cvd: number,
  vdRatio: number,
  bookImbalance: number,
  vwap: number,
  spreadBps: number,
  pricePct: number,
  avgTradeSize: number,
  evr: number,
  smp: number
): void {
  updateMetricOHLC(ohlc.vd, vd);
  updateMetricOHLC(ohlc.cvd, cvd);
  updateMetricOHLC(ohlc.vdRatio, vdRatio);
  updateMetricOHLC(ohlc.bookImbalance, bookImbalance);
  updateMetricOHLC(ohlc.vwap, vwap);
  updateMetricOHLC(ohlc.spreadBps, spreadBps);
  updateMetricOHLC(ohlc.pricePct, pricePct);
  updateMetricOHLC(ohlc.avgTradeSize, avgTradeSize);
  updateMetricOHLC(ohlc.evr, evr);
  updateMetricOHLC(ohlc.smp, smp);
}
