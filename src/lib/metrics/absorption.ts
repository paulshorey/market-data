/**
 * Absorption Metrics: divergence, evr
 *
 * Flags hidden accumulation/distribution by detecting when aggressive
 * volume doesn't move price as expected.
 */

/** Minimum thresholds for meaningful divergence detection */
const DIVERGENCE_MIN_PRICE_PCT = 0.5; // At least 0.5 basis points price move (0.005%)
const DIVERGENCE_MIN_VD_RATIO = 0.1; // At least 10% volume imbalance

/**
 * Detect delta-price divergence (accumulation/distribution signal)
 *
 * Divergence occurs when price and volume delta move in opposite directions,
 * indicating that aggressive orders are being absorbed by passive limit orders.
 *
 * - Bullish divergence (+1): Sellers aggressive (VD < 0) but price went UP
 *   → Passive buyers absorbing sell orders (ACCUMULATION)
 *   → Large traders building long positions without pushing price down
 *
 * - Bearish divergence (-1): Buyers aggressive (VD > 0) but price went DOWN
 *   → Passive sellers absorbing buy orders (DISTRIBUTION)
 *   → Large traders distributing positions despite buying pressure
 *
 * - No divergence (0): Price followed the aggressor direction (normal behavior)
 *
 * IMPROVED: Now requires minimum thresholds to filter noise:
 * - Price must move at least 0.5 basis points (0.005%)
 * - VD ratio must be at least 10% imbalance
 *
 * @param pricePct - Normalized price change (basis points)
 * @param vdRatio - VD ratio (-1 to +1)
 * @returns 1 for bullish, -1 for bearish, 0 for no divergence
 */
export function calculateDivergence(pricePct: number, vdRatio: number): -1 | 0 | 1 {
  // Require minimum thresholds to avoid noise
  const absPricePct = Math.abs(pricePct);
  const absVdRatio = Math.abs(vdRatio);

  // Not enough movement or imbalance to be meaningful
  if (absPricePct < DIVERGENCE_MIN_PRICE_PCT || absVdRatio < DIVERGENCE_MIN_VD_RATIO) {
    return 0;
  }

  // Bullish divergence: bearish VD (sellers aggressive) but price went up
  // This means sellers are being absorbed - accumulation zone
  if (vdRatio < 0 && pricePct > 0) return 1;

  // Bearish divergence: bullish VD (buyers aggressive) but price went down
  // This means buyers are being absorbed - distribution zone
  if (vdRatio > 0 && pricePct < 0) return -1;

  return 0;
}

/**
 * Calculate Effort vs Result (EVR) absorption score
 *
 * EVR measures the efficiency of aggressive volume in moving price.
 * When effort (aggressive volume) doesn't produce result (price movement),
 * it indicates absorption - large limit orders absorbing market orders.
 *
 * Formula: EVR = pricePct / (|vdRatio| * 100)
 *
 * Interpretation:
 * - |EVR| > 1.0: Very efficient - price moved more than expected for the imbalance
 * - |EVR| 0.5-1.0: Normal efficiency - price followed imbalance proportionally
 * - |EVR| < 0.5: Low efficiency - possible absorption
 * - |EVR| ≈ 0 with high |vdRatio|: Strong absorption signal
 * - EVR = null: No meaningful imbalance to measure (vdRatio < 5%)
 *
 * EVR sign indicates price direction (positive = up, negative = down).
 * Compare with vdRatio sign to detect divergence:
 * - Same sign: Price followed aggressor (normal)
 * - Opposite sign: Price moved against aggressor (absorption/divergence)
 *
 * Combined analysis:
 * - Low |EVR| + divergence flag: Strong absorption (accumulation/distribution)
 * - Low |EVR| + no divergence: Price stalled (consolidation, range-bound)
 * - High |EVR| + no divergence: Clean trend move
 *
 * @param pricePct - Normalized price change (basis points)
 * @param vdRatio - VD ratio (-1 to +1)
 * @returns EVR score, or null if vdRatio < 5% (no meaningful imbalance)
 */
export function calculateEvr(pricePct: number, vdRatio: number): number | null {
  // If VD ratio is very small (< 5% imbalance), EVR is not meaningful
  // Return null to distinguish from "EVR = 0" which means absorption
  const absVdRatio = Math.abs(vdRatio);
  if (absVdRatio < 0.05) return null;

  // Scale vdRatio to percentage (0-100) for more intuitive EVR values
  // A 50% VD ratio with 10bp price move = EVR of 0.2
  return pricePct / (absVdRatio * 100);
}
