/**
 * Backtest Module
 * 
 * High-performance backtesting framework with multi-timeframe support.
 * 
 * Example usage:
 * 
 * ```javascript
 * const { BacktestEngine } = require('./backtest');
 * const { Pool } = require('pg');
 * 
 * const pool = new Pool({ ... });
 * 
 * const engine = new BacktestEngine({
 *   symbol: 'BTCUSDT',
 *   timeframes: [1, 60, 240, 1440],
 *   pool,
 *   startTime: '2024-01-01',
 *   initialCapital: 100000
 * });
 * 
 * await engine.initialize();
 * 
 * const report = await engine.run((ctx) => {
 *   const rsi = ctx.tf(60).current().rsi14;
 *   
 *   if (rsi < 30 && ctx.position === 0) {
 *     ctx.buy(1);
 *   }
 *   
 *   if (rsi > 70 && ctx.position > 0) {
 *     ctx.close();
 *   }
 * });
 * 
 * console.log(report);
 * ```
 */

const { BacktestEngine } = require('./BacktestEngine');
const { TimeframeBuffer, WINDOW_SIZE, BUFFER_SIZE } = require('./TimeframeBuffer');

module.exports = {
  BacktestEngine,
  TimeframeBuffer,
  WINDOW_SIZE,
  BUFFER_SIZE
};
