/**
 * Composite Metrics: smp (Smart Money Pressure)
 *
 * Combines everything into one actionable score that represents
 * the likely direction and strength of institutional activity.
 */

import type { SmpInput } from "./types.js";

/**
 * Calculate Smart Money Pressure (SMP) - Institutional-Weighted Directional Score
 *
 * SMP combines multiple order flow metrics into a single score that represents
 * the likely direction and strength of institutional activity. The score is
 * weighted more heavily when large/institutional trades are present.
 *
 * Formula components:
 * 1. Base signal = vdRatio × 50 (convert to -50 to +50 range)
 * 2. Institutional weight = 1 + (bigVolume / volume) (1x to 2x multiplier)
 * 3. Book confluence = ±15 if book_imbalance aligns with vdRatio direction
 * 4. Absorption adjustment = ±20 based on EVR and divergence
 * 5. Confidence penalty = -10% if spread > 5bps (uncertain conditions)
 *
 * Score interpretation:
 * - +50 to +100: Strong institutional buying, likely upward continuation
 * - +20 to +50: Moderate bullish pressure
 * - -20 to +20: Neutral/consolidation or reversal setup
 * - -50 to -20: Moderate bearish pressure
 * - -100 to -50: Strong institutional selling, likely downward continuation
 *
 * Special cases:
 * - Divergence present: Score moves toward divergence direction (reversal signal)
 * - Low EVR + high vdRatio: Absorption detected, score dampened
 * - High big_volume %: Score amplified (institutional conviction)
 *
 * @param input - All metrics needed for SMP calculation
 * @returns SMP score bounded -100 to +100
 */
export function calculateSmp(input: SmpInput): number {
  const {
    vdRatio,
    bookImbalance,
    bigVolume,
    volume,
    evr,
    divergence,
    spreadBps,
    vdStrength = 1,
  } = input;

  // 1. BASE SIGNAL: vdRatio scaled to -50 to +50
  // This is the primary directional component
  let score = vdRatio * 50;

  // 2. INSTITUTIONAL WEIGHT: Amplify when big trades present
  // bigVolume / volume gives 0 to 1 ratio
  // We use this to create a 1x to 2x multiplier
  const bigTradeRatio = volume > 0 ? bigVolume / volume : 0;
  const institutionalMultiplier = 1 + bigTradeRatio;
  score *= institutionalMultiplier;

  // 2b. MOMENTUM WEIGHT: Amplify when pressure is accelerating
  // vdStrength > 1 means current pressure exceeds recent average
  // Cap the boost to avoid extreme values
  if (vdStrength > 1) {
    // Accelerating momentum - boost score up to 30%
    const momentumBoost = Math.min(vdStrength - 1, 0.5) * 0.6; // Max 30% boost
    score *= 1 + momentumBoost;
  } else if (vdStrength < 0.7) {
    // Decelerating momentum (below 70% of average) - dampen score
    // This indicates exhaustion even if direction is strong
    score *= 0.8;
  }

  // 3. BOOK CONFLUENCE: Add ±15 if passive order book confirms direction
  // Positive book_imbalance = more bid depth (bullish support)
  // We want this to add when it aligns with vdRatio direction
  const bookAligned =
    (vdRatio > 0 && bookImbalance > 0) || (vdRatio < 0 && bookImbalance < 0);
  const bookConflicting =
    (vdRatio > 0 && bookImbalance < -0.2) || (vdRatio < 0 && bookImbalance > 0.2);

  if (bookAligned) {
    // Book confirms direction - add up to 15 based on imbalance strength
    score += Math.sign(vdRatio) * Math.abs(bookImbalance) * 15;
  } else if (bookConflicting) {
    // Book opposes direction - warning sign, reduce score
    score -= Math.sign(vdRatio) * Math.abs(bookImbalance) * 10;
  }

  // 4. ABSORPTION ADJUSTMENT: Detect hidden accumulation/distribution
  // Divergence indicates price moved against aggressor (absorption)
  if (divergence !== 0) {
    // Divergence detected - this is a potential reversal signal
    // Shift score toward the divergence direction
    // The stronger the original vdRatio, the stronger the divergence signal
    const divergenceStrength = Math.abs(vdRatio) * 25;
    score += divergence * divergenceStrength;
  }

  // EVR measures efficiency: low EVR with high vdRatio = absorption
  if (evr !== null) {
    const absEvr = Math.abs(evr);
    const absVdRatio = Math.abs(vdRatio);

    if (absEvr < 0.3 && absVdRatio > 0.3) {
      // Strong imbalance but weak price movement = absorption
      // Dampen the score (market is absorbing, not trending)
      score *= 0.7;
    } else if (absEvr > 1.5 && absVdRatio > 0.3) {
      // Price moved efficiently with the imbalance = clean trend
      // Boost the score
      score *= 1.2;
    }
  }

  // 5. CONFIDENCE PENALTY: Wide spread indicates uncertainty
  // Normal spread < 2bps, uncertain > 5bps
  if (spreadBps > 5) {
    // Reduce confidence when spread is wide
    const spreadPenalty = Math.min((spreadBps - 5) / 10, 0.3); // Max 30% penalty
    score *= 1 - spreadPenalty;
  }

  // Clamp to -100 to +100 range
  return Math.max(-100, Math.min(100, Math.round(score)));
}
