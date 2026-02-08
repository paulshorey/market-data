/**
 * Backtest Runner
 * 
 * Example usage of the BacktestEngine with sample strategies.
 * 
 * Usage: node src/backtest/run.js <symbol> [startDate] [endDate]
 * 
 * Examples:
 *   node src/backtest/run.js BTCUSDT
 *   node src/backtest/run.js BTCUSDT 2024-01-01
 *   node src/backtest/run.js BTCUSDT 2024-01-01 2024-06-01
 */

const { Pool } = require('pg');
const { BacktestEngine } = require('./BacktestEngine');

// Database connection
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'trading',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || ''
});

// ============================================================================
// EXAMPLE STRATEGIES
// ============================================================================

/**
 * Simple RSI Strategy
 * 
 * Uses 1-hour RSI:
 * - Buy when RSI crosses below 30 (oversold)
 * - Sell when RSI crosses above 70 (overbought)
 */
function rsiStrategy(ctx) {
  const tf60 = ctx.tf(60);  // 1-hour timeframe
  
  const currentRSI = tf60.current().rsi14;
  const previousRSI = tf60.get(1)?.rsi14;
  
  if (currentRSI === null || previousRSI === null) {
    return;  // Not enough data yet
  }

  // Buy signal: RSI crosses below 30
  if (previousRSI >= 30 && currentRSI < 30 && ctx.position === 0) {
    ctx.buy(1);
    ctx.log(`BUY: RSI crossed below 30 (${currentRSI.toFixed(1)})`);
  }
  
  // Sell signal: RSI crosses above 70
  if (previousRSI <= 70 && currentRSI > 70 && ctx.position > 0) {
    ctx.close();
    ctx.log(`SELL: RSI crossed above 70 (${currentRSI.toFixed(1)})`);
  }
}

/**
 * Multi-Timeframe RSI Strategy
 * 
 * Uses both 1-hour and 4-hour RSI for confirmation:
 * - Buy when 1h RSI < 30 AND 4h RSI < 40 (both oversold)
 * - Sell when 1h RSI > 70 OR 4h RSI > 70 (either overbought)
 */
function multiTfRsiStrategy(ctx) {
  const tf60 = ctx.tf(60);    // 1-hour
  const tf240 = ctx.tf(240);  // 4-hour
  
  const rsi1h = tf60.current().rsi14;
  const rsi4h = tf240.current().rsi14;
  
  if (rsi1h === null || rsi4h === null) {
    return;
  }

  // Buy: both timeframes show oversold
  if (rsi1h < 30 && rsi4h < 40 && ctx.position === 0) {
    ctx.buy(1);
    ctx.log(`BUY: 1h RSI=${rsi1h.toFixed(1)}, 4h RSI=${rsi4h.toFixed(1)}`);
  }
  
  // Sell: either timeframe shows overbought
  if ((rsi1h > 70 || rsi4h > 70) && ctx.position > 0) {
    ctx.close();
    ctx.log(`SELL: 1h RSI=${rsi1h.toFixed(1)}, 4h RSI=${rsi4h.toFixed(1)}`);
  }
}

/**
 * Price Action + RSI Divergence (more complex example)
 * 
 * Looks for bullish divergence: price making lower lows while RSI makes higher lows
 */
function divergenceStrategy(ctx) {
  const tf60 = ctx.tf(60);
  
  // Get last 20 bars of data
  const closes = tf60.series('close', 20);
  const rsiValues = tf60.series('rsi14', 20);
  
  if (closes.length < 20 || rsiValues.some(v => v === null)) {
    return;
  }

  // Find local lows in price (simple: lower than neighbors)
  const priceLows = [];
  for (let i = 2; i < closes.length - 2; i++) {
    if (closes[i] < closes[i-1] && closes[i] < closes[i-2] &&
        closes[i] < closes[i+1] && closes[i] < closes[i+2]) {
      priceLows.push({ index: i, price: closes[i], rsi: rsiValues[i] });
    }
  }

  if (priceLows.length < 2) {
    return;
  }

  // Check for bullish divergence: price lower low, RSI higher low
  const recent = priceLows[priceLows.length - 1];
  const prior = priceLows[priceLows.length - 2];

  if (recent.price < prior.price && recent.rsi > prior.rsi) {
    // Bullish divergence detected
    if (ctx.position === 0) {
      ctx.buy(1);
      ctx.log(`BUY: Bullish divergence - Price: ${prior.price.toFixed(2)} -> ${recent.price.toFixed(2)}, RSI: ${prior.rsi.toFixed(1)} -> ${recent.rsi.toFixed(1)}`);
    }
  }

  // Simple exit: RSI > 60
  if (tf60.current().rsi14 > 60 && ctx.position > 0) {
    ctx.close();
    ctx.log(`SELL: RSI > 60`);
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 1) {
    console.log('Usage: node src/backtest/run.js <symbol> [startDate] [endDate]');
    console.log('');
    console.log('Examples:');
    console.log('  node src/backtest/run.js BTCUSDT');
    console.log('  node src/backtest/run.js BTCUSDT 2024-01-01');
    console.log('  node src/backtest/run.js BTCUSDT 2024-01-01 2024-06-01');
    process.exit(1);
  }

  const symbol = args[0];
  const startTime = args[1] || '2020-01-01';  // Default to 2020
  const endTime = args[2] || null;

  // Select which strategy to run
  const strategy = rsiStrategy;  // Change this to test different strategies
  // const strategy = multiTfRsiStrategy;
  // const strategy = divergenceStrategy;

  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║              BACKTESTING FRAMEWORK                         ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  try {
    // Create the engine
    const engine = new BacktestEngine({
      symbol,
      timeframes: [1, 60, 240, 1440],  // 1m, 1h, 4h, 1D
      pool,
      startTime,
      endTime,
      initialCapital: 100000,
      windowSize: 5000
    });

    // Suppress individual trade logs for large backtests
    engine.suppressLogs = true;

    // Initialize (loads data)
    await engine.initialize();

    // Run the backtest
    const report = await engine.run(strategy);

    // Optionally save report to file
    // const fs = require('fs');
    // fs.writeFileSync('backtest-report.json', JSON.stringify(report, null, 2));

  } catch (err) {
    console.error('Backtest failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
