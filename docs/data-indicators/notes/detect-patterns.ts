#!/usr/bin/env npx tsx
/**
 * Market Pattern Detection Queries
 *
 * 4 key patterns for trading decisions:
 * 1. BEARISH ABSORPTION - Buyers hitting resistance (bearish reversal signal)
 * 2. BULLISH ABSORPTION - Sellers hitting support (bullish reversal signal)
 * 3. BULLISH MOMENTUM - Clean uptrend with no resistance
 * 4. BEARISH MOMENTUM - Clean downtrend with no support
 */
import "dotenv/config";
import { pool } from "../../../src/lib/db.js";

async function run() {
  const ticker = process.argv[2] || "ES";
  console.log(`\n${"═".repeat(80)}`);
  console.log(`   MARKET PATTERN DETECTION - ${ticker}`);
  console.log(`${"═".repeat(80)}\n`);

  // ════════════════════════════════════════════════════════════════════════════
  // 1. BEARISH ABSORPTION - Buyers hitting resistance (potential bearish reversal)
  // ════════════════════════════════════════════════════════════════════════════
  // Pattern: Aggressive buyers (vd > 0) but price goes DOWN
  // Meaning: Large passive sellers absorbing buy orders → distribution → bearish
  // Key indicators:
  //   - divergence = -1 (price dropped despite buying)
  //   - vd_ratio > 0 (buyers were aggressive)
  //   - book_imbalance < 0 (more sellers in book = resistance above)
  //   - big_trades confirms institutional involvement

  console.log("┌─────────────────────────────────────────────────────────────────────────────┐");
  console.log("│  1. BEARISH ABSORPTION - Buyers hitting resistance (SELL SIGNAL)           │");
  console.log("│     Aggressive buying absorbed by large passive sellers = Distribution     │");
  console.log("└─────────────────────────────────────────────────────────────────────────────┘\n");

  const bearishAbsorption = await pool.query(
    `
    SELECT 
      time,
      close,
      ROUND(vd_ratio::numeric, 3) as vd_ratio,
      ROUND(book_imbalance::numeric, 3) as book_imb,
      ROUND(price_pct::numeric, 2) as price_pct,
      big_trades,
      big_volume
    FROM "candles-1m"
    WHERE ticker = $1
      AND divergence = -1                      -- Price DOWN despite buying
      AND vd_ratio > 0.15                      -- Meaningful buy pressure
      AND book_imbalance IS NOT NULL           -- Has book data
    ORDER BY 
      big_trades DESC,                         -- Prioritize institutional signals
      ABS(vd_ratio) DESC                       -- Then by imbalance strength
    LIMIT 15
  `,
    [ticker],
  );

  if (bearishAbsorption.rows.length > 0) {
    console.table(bearishAbsorption.rows);
    console.log("  → vd_ratio > 0 = buyers aggressive, but price fell (divergence = -1)");
    console.log("  → book_imb < 0 = more passive sellers waiting (resistance)\n");
  } else {
    console.log("  No bearish absorption signals found.\n");
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 2. BULLISH ABSORPTION - Sellers hitting support (potential bullish reversal)
  // ════════════════════════════════════════════════════════════════════════════
  // Pattern: Aggressive sellers (vd < 0) but price goes UP
  // Meaning: Large passive buyers absorbing sell orders → accumulation → bullish
  // Key indicators:
  //   - divergence = 1 (price rose despite selling)
  //   - vd_ratio < 0 (sellers were aggressive)
  //   - book_imbalance > 0 (more buyers in book = support below)
  //   - big_trades confirms institutional involvement

  console.log("┌─────────────────────────────────────────────────────────────────────────────┐");
  console.log("│  2. BULLISH ABSORPTION - Sellers hitting support (BUY SIGNAL)              │");
  console.log("│     Aggressive selling absorbed by large passive buyers = Accumulation     │");
  console.log("└─────────────────────────────────────────────────────────────────────────────┘\n");

  const bullishAbsorption = await pool.query(
    `
    SELECT 
      time,
      close,
      ROUND(vd_ratio::numeric, 3) as vd_ratio,
      ROUND(book_imbalance::numeric, 3) as book_imb,
      ROUND(price_pct::numeric, 2) as price_pct,
      big_trades,
      big_volume
    FROM "candles-1m"
    WHERE ticker = $1
      AND divergence = 1                       -- Price UP despite selling
      AND vd_ratio < -0.15                     -- Meaningful sell pressure
      AND book_imbalance IS NOT NULL           -- Has book data
    ORDER BY 
      big_trades DESC,                         -- Prioritize institutional signals
      ABS(vd_ratio) DESC                       -- Then by imbalance strength
    LIMIT 15
  `,
    [ticker],
  );

  if (bullishAbsorption.rows.length > 0) {
    console.table(bullishAbsorption.rows);
    console.log("  → vd_ratio < 0 = sellers aggressive, but price rose (divergence = 1)");
    console.log("  → book_imb > 0 = more passive buyers waiting (support)\n");
  } else {
    console.log("  No bullish absorption signals found.\n");
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 3. BULLISH MOMENTUM - Clean uptrend, no resistance
  // ════════════════════════════════════════════════════════════════════════════
  // Pattern: Buyers aggressive AND price moving up efficiently
  // Meaning: No absorption, clean trend, momentum likely to continue
  // Key indicators:
  //   - vd_ratio > 0 (buyers aggressive)
  //   - price_pct > 0 (price rising)
  //   - divergence = 0 (price following aggressor = normal)
  //   - Optional: book_imbalance > 0 (support below, no resistance)

  console.log("┌─────────────────────────────────────────────────────────────────────────────┐");
  console.log("│  3. BULLISH MOMENTUM - Clean uptrend, no resistance (TREND CONTINUATION)   │");
  console.log("│     Aggressive buying moving price up efficiently = Strong uptrend         │");
  console.log("└─────────────────────────────────────────────────────────────────────────────┘\n");

  const bullishMomentum = await pool.query(
    `
    SELECT 
      time,
      close,
      ROUND(vd_ratio::numeric, 3) as vd_ratio,
      ROUND(book_imbalance::numeric, 3) as book_imb,
      ROUND(price_pct::numeric, 2) as price_pct,
      big_trades
    FROM "candles-1m"
    WHERE ticker = $1
      AND divergence = 0                       -- Price following aggressor (clean move)
      AND vd_ratio > 0.15                      -- Buy pressure
      AND price_pct > 0.5                      -- Price moving up
      AND book_imbalance IS NOT NULL           -- Has book data
    ORDER BY 
      (vd_ratio * price_pct) DESC,             -- Combined momentum score
      big_trades DESC                          -- Then by institutional involvement
    LIMIT 15
  `,
    [ticker],
  );

  if (bullishMomentum.rows.length > 0) {
    console.table(bullishMomentum.rows);
    console.log("  → vd_ratio > 0 AND price_pct > 0 = buyers pushing price UP (no absorption)");
    console.log("  → divergence = 0 = price following aggressor (healthy trend)\n");
  } else {
    console.log("  No bullish momentum signals found.\n");
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 4. BEARISH MOMENTUM - Clean downtrend, no support
  // ════════════════════════════════════════════════════════════════════════════
  // Pattern: Sellers aggressive AND price moving down efficiently
  // Meaning: No absorption, clean trend, momentum likely to continue
  // Key indicators:
  //   - vd_ratio < 0 (sellers aggressive)
  //   - price_pct < 0 (price falling)
  //   - divergence = 0 (price following aggressor = normal)
  //   - Optional: book_imbalance < 0 (resistance above, no support)

  console.log("┌─────────────────────────────────────────────────────────────────────────────┐");
  console.log("│  4. BEARISH MOMENTUM - Clean downtrend, no support (TREND CONTINUATION)    │");
  console.log("│     Aggressive selling moving price down efficiently = Strong downtrend    │");
  console.log("└─────────────────────────────────────────────────────────────────────────────┘\n");

  const bearishMomentum = await pool.query(
    `
    SELECT 
      time,
      close,
      ROUND(vd_ratio::numeric, 3) as vd_ratio,
      ROUND(book_imbalance::numeric, 3) as book_imb,
      ROUND(price_pct::numeric, 2) as price_pct,
      big_trades
    FROM "candles-1m"
    WHERE ticker = $1
      AND divergence = 0                       -- Price following aggressor (clean move)
      AND vd_ratio < -0.15                     -- Sell pressure
      AND price_pct < -0.5                     -- Price moving down
      AND book_imbalance IS NOT NULL           -- Has book data
    ORDER BY 
      (ABS(vd_ratio) * ABS(price_pct)) DESC,  -- Combined momentum score
      big_trades DESC                          -- Then by institutional involvement
    LIMIT 15
  `,
    [ticker],
  );

  if (bearishMomentum.rows.length > 0) {
    console.table(bearishMomentum.rows);
    console.log("  → vd_ratio < 0 AND price_pct < 0 = sellers pushing price DOWN (no absorption)");
    console.log("  → book_imb < 0 = passive sellers above (resistance), path of least resistance is DOWN");
    console.log("  → divergence = 0 = price following aggressor (healthy trend)\n");
  } else {
    console.log("  No bearish momentum signals found.\n");
  }

  // ════════════════════════════════════════════════════════════════════════════
  // SUMMARY COUNTS
  // ════════════════════════════════════════════════════════════════════════════
  console.log("═".repeat(80));
  console.log("PATTERN SUMMARY (all time for recent data with book info):");
  console.log("═".repeat(80));

  const summary = await pool.query(
    `
    SELECT 
      -- Bearish absorption (distribution)
      COUNT(CASE WHEN divergence = -1 AND vd_ratio > 0.15 THEN 1 END) as bearish_absorption,
      -- Bullish absorption (accumulation)
      COUNT(CASE WHEN divergence = 1 AND vd_ratio < -0.15 THEN 1 END) as bullish_absorption,
      -- Bullish momentum
      COUNT(CASE WHEN divergence = 0 AND vd_ratio > 0.15 AND price_pct > 0.5 THEN 1 END) as bullish_momentum,
      -- Bearish momentum
      COUNT(CASE WHEN divergence = 0 AND vd_ratio < -0.15 AND price_pct < -0.5 THEN 1 END) as bearish_momentum,
      -- Total candles with book data
      COUNT(CASE WHEN book_imbalance IS NOT NULL THEN 1 END) as total_with_book_data
    FROM "candles-1m"
    WHERE ticker = $1
  `,
    [ticker],
  );

  console.table(summary.rows);

  console.log("\n" + "═".repeat(80));
  console.log("INTERPRETATION GUIDE:");
  console.log("═".repeat(80));
  console.log(`
  ABSORPTION SIGNALS (Reversal Setups):
  ─────────────────────────────────────
  • Bearish Absorption: Buyers aggressive but price DOWN = sellers absorbing = SELL signal
  • Bullish Absorption: Sellers aggressive but price UP = buyers absorbing = BUY signal
  • Best when: big_trades > 0 (institutional), book_imbalance confirms direction
  
  MOMENTUM SIGNALS (Trend Continuation):
  ──────────────────────────────────────
  • Bullish Momentum: Buyers aggressive AND price UP AND support below = LONG continuation
  • Bearish Momentum: Sellers aggressive AND price DOWN AND resistance above = SHORT continuation
  • Best when: divergence = 0, strong vd_ratio

  KEY METRICS:
  ────────────
  • vd_ratio: Who's aggressive? >0 = buyers, <0 = sellers
  • divergence: Did price follow aggressor? 0 = yes, ±1 = no (absorption)
  • book_imbalance: Passive liquidity. >0 = support below, <0 = resistance above
  • big_trades: Institutional involvement confirmation
  `);

  await pool.end();
}

run().catch(console.error);
