/**
 * BacktestEngine
 * 
 * Orchestrates backtesting across multiple timeframes.
 * 
 * Provides the strategy with access to:
 * - Rolling windows of 5,000 bars per timeframe
 * - Current positions and account state
 * - Order placement functions
 * 
 * Handles:
 * - Synchronized iteration across all timeframes
 * - Chunked data loading for memory efficiency
 * - Position/order management
 * - Performance tracking
 */

const { TimeframeBuffer, WINDOW_SIZE } = require('./TimeframeBuffer');

class BacktestEngine {
  /**
   * @param {object} config
   * @param {string} config.symbol - Trading symbol
   * @param {number[]} config.timeframes - Array of timeframes [1, 5, 15, 60, ...]
   * @param {object} config.pool - PostgreSQL connection pool
   * @param {Date|string} config.startTime - Backtest start time
   * @param {Date|string} [config.endTime] - Backtest end time (optional)
   * @param {number} [config.initialCapital=100000] - Starting capital
   * @param {number} [config.windowSize=5000] - Bars available per timeframe
   */
  constructor(config) {
    this.symbol = config.symbol;
    this.timeframes = config.timeframes.sort((a, b) => a - b);  // Smallest first
    this.pool = config.pool;
    this.startTime = new Date(config.startTime);
    this.endTime = config.endTime ? new Date(config.endTime) : null;
    this.windowSize = config.windowSize || WINDOW_SIZE;

    // Timeframe buffers (one per timeframe)
    this.buffers = new Map();

    // Account state
    this.initialCapital = config.initialCapital || 100000;
    this.capital = this.initialCapital;
    this.position = 0;          // Current position (positive = long, negative = short)
    this.positionPrice = 0;     // Average entry price
    this.equity = this.initialCapital;

    // Order queue (processed at end of bar)
    this.pendingOrders = [];

    // Trade history
    this.trades = [];
    this.equityCurve = [];

    // Stats
    this.barCount = 0;
    this.startMs = 0;
    this.lastProgressUpdate = 0;
  }

  /**
   * Initialize all timeframe buffers
   */
  async initialize() {
    console.log('\n=== Initializing Backtest Engine ===');
    console.log(`Symbol: ${this.symbol}`);
    console.log(`Timeframes: ${this.timeframes.join(', ')} minutes`);
    console.log(`Start: ${this.startTime.toISOString()}`);
    console.log(`Window size: ${this.windowSize.toLocaleString()} bars per timeframe`);
    console.log('');

    // Calculate actual start time (need windowSize bars of history)
    // Use the largest timeframe to calculate offset
    const maxTimeframe = Math.max(...this.timeframes);
    const historyNeeded = this.windowSize * maxTimeframe;  // minutes of history
    const dataStartTime = new Date(this.startTime.getTime() - historyNeeded * 60 * 1000);

    console.log(`Loading data from: ${dataStartTime.toISOString()}`);
    console.log('');

    // Initialize each timeframe buffer
    for (const tf of this.timeframes) {
      const buffer = new TimeframeBuffer({
        timeframe: tf,
        symbol: this.symbol,
        pool: this.pool,
        windowSize: this.windowSize
      });

      const success = await buffer.initialize(dataStartTime);
      if (!success) {
        throw new Error(`Failed to initialize ${tf}m buffer - not enough data`);
      }

      this.buffers.set(tf, buffer);
    }

    // Fast-forward all buffers to the actual start time
    console.log('\nFast-forwarding to start time...');
    await this._fastForwardToStart();

    console.log('\n=== Initialization Complete ===\n');
  }

  /**
   * Fast-forward all buffers until we reach the start time
   */
  async _fastForwardToStart() {
    const primaryBuffer = this.buffers.get(this.timeframes[0]);
    
    while (primaryBuffer.current().ts < this.startTime) {
      // Advance all buffers
      for (const buffer of this.buffers.values()) {
        if (!buffer.advance()) {
          throw new Error('Ran out of data while fast-forwarding');
        }
      }

      // Refill if needed
      await this._refillIfNeeded();
    }

    console.log(`Fast-forwarded to: ${primaryBuffer.current().ts.toISOString()}`);
  }

  /**
   * Refill any buffers that need more data
   */
  async _refillIfNeeded() {
    for (const [tf, buffer] of this.buffers) {
      if (buffer.needsRefill()) {
        const loaded = await buffer.refill();
        if (loaded > 0) {
          // Uncomment for debugging:
          // console.log(`  [${tf}m] Refilled ${loaded.toLocaleString()} rows`);
        }
      }
    }
  }

  /**
   * Run the backtest
   * 
   * @param {function} strategy - Strategy function: (ctx) => void
   *   ctx contains: { tf, current, get, series, position, capital, buy, sell, close }
   */
  async run(strategy) {
    console.log('=== Starting Backtest ===\n');
    this.startMs = Date.now();

    const primaryBuffer = this.buffers.get(this.timeframes[0]);

    // Main loop - iterate through each bar
    while (!this._isComplete(primaryBuffer)) {
      const currentTs = primaryBuffer.current().ts;

      // Build context for strategy
      const ctx = this._buildContext(currentTs);

      // Run strategy
      try {
        strategy(ctx);
      } catch (err) {
        console.error(`Strategy error at ${currentTs}:`, err.message);
      }

      // Process pending orders (execute at close of this bar)
      this._processOrders(currentTs, primaryBuffer.current().close);

      // Update equity
      this._updateEquity(primaryBuffer.current().close);

      // Record equity curve (sample every 1000 bars to save memory)
      if (this.barCount % 1000 === 0) {
        this.equityCurve.push({
          ts: currentTs,
          equity: this.equity,
          position: this.position
        });
      }

      // Advance all buffers
      for (const buffer of this.buffers.values()) {
        buffer.advance();
      }

      // Refill buffers if needed
      await this._refillIfNeeded();

      // Progress update
      this.barCount++;
      this._printProgress(currentTs);
    }

    // Final results
    this._printResults();

    return this._generateReport();
  }

  /**
   * Check if backtest is complete
   */
  _isComplete(primaryBuffer) {
    if (primaryBuffer.isExhausted()) {
      return true;
    }
    if (this.endTime && primaryBuffer.current().ts >= this.endTime) {
      return true;
    }
    return false;
  }

  /**
   * Build the context object passed to the strategy
   */
  _buildContext(currentTs) {
    const engine = this;

    return {
      // Current timestamp
      time: currentTs,

      // Access to timeframe data
      // Usage: ctx.tf(60).current(), ctx.tf(60).get(1), ctx.tf(60).series('close', 14)
      tf: (timeframe) => {
        const buffer = engine.buffers.get(timeframe);
        if (!buffer) {
          throw new Error(`Timeframe ${timeframe} not loaded`);
        }
        return {
          current: () => buffer.current(),
          get: (barsAgo) => buffer.get(barsAgo),
          series: (field, length) => buffer.series(field, length),
          window: () => buffer.window()
        };
      },

      // Shorthand for 1-minute data
      get current() {
        return engine.buffers.get(engine.timeframes[0]).current();
      },

      // Account state
      get position() { return engine.position; },
      get positionPrice() { return engine.positionPrice; },
      get capital() { return engine.capital; },
      get equity() { return engine.equity; },

      // Order functions
      buy: (quantity, price = null) => {
        engine.pendingOrders.push({
          side: 'buy',
          quantity: Math.abs(quantity),
          price
        });
      },

      sell: (quantity, price = null) => {
        engine.pendingOrders.push({
          side: 'sell',
          quantity: Math.abs(quantity),
          price
        });
      },

      // Close entire position
      close: () => {
        if (engine.position > 0) {
          engine.pendingOrders.push({
            side: 'sell',
            quantity: engine.position,
            price: null
          });
        } else if (engine.position < 0) {
          engine.pendingOrders.push({
            side: 'buy',
            quantity: Math.abs(engine.position),
            price: null
          });
        }
      },

      // Logging (only logs if not suppressed)
      log: (...args) => {
        if (!engine.suppressLogs) {
          console.log(`[${currentTs.toISOString()}]`, ...args);
        }
      }
    };
  }

  /**
   * Process pending orders at bar close
   */
  _processOrders(ts, price) {
    for (const order of this.pendingOrders) {
      const execPrice = order.price || price;  // Market order uses bar close

      if (order.side === 'buy') {
        const cost = order.quantity * execPrice;
        
        if (this.position <= 0) {
          // Opening or adding to long
          const newPosition = this.position + order.quantity;
          this.positionPrice = this.position === 0 
            ? execPrice 
            : (this.positionPrice * Math.abs(this.position) + execPrice * order.quantity) / newPosition;
          this.position = newPosition;
        } else {
          // Closing short
          const closedQty = Math.min(order.quantity, Math.abs(this.position));
          const pnl = closedQty * (this.positionPrice - execPrice);
          this.capital += pnl;
          this.position += order.quantity;
          
          this.trades.push({
            ts,
            side: 'buy',
            quantity: closedQty,
            price: execPrice,
            pnl,
            capital: this.capital
          });
        }
      } else {  // sell
        if (this.position >= 0) {
          // Closing long
          const closedQty = Math.min(order.quantity, this.position);
          if (closedQty > 0) {
            const pnl = closedQty * (execPrice - this.positionPrice);
            this.capital += pnl;
            
            this.trades.push({
              ts,
              side: 'sell',
              quantity: closedQty,
              price: execPrice,
              pnl,
              capital: this.capital
            });
          }
          this.position -= order.quantity;
          if (this.position < 0) {
            this.positionPrice = execPrice;  // New short position
          }
        } else {
          // Adding to short
          const newPosition = this.position - order.quantity;
          this.positionPrice = (this.positionPrice * Math.abs(this.position) + execPrice * order.quantity) / Math.abs(newPosition);
          this.position = newPosition;
        }
      }
    }

    this.pendingOrders = [];
  }

  /**
   * Update equity based on current position and price
   */
  _updateEquity(currentPrice) {
    const unrealizedPnL = this.position * (currentPrice - this.positionPrice);
    this.equity = this.capital + unrealizedPnL;
  }

  /**
   * Print progress update
   */
  _printProgress(currentTs) {
    const now = Date.now();
    if (now - this.lastProgressUpdate > 2000) {  // Every 2 seconds
      const elapsed = (now - this.startMs) / 1000;
      const barsPerSec = Math.round(this.barCount / elapsed);
      const memUsage = process.memoryUsage();
      const heapMB = Math.round(memUsage.heapUsed / 1024 / 1024);

      process.stdout.write(
        `\rProcessed ${this.barCount.toLocaleString()} bars | ` +
        `${barsPerSec.toLocaleString()} bars/sec | ` +
        `${currentTs.toISOString().slice(0, 10)} | ` +
        `Heap: ${heapMB} MB | ` +
        `Trades: ${this.trades.length}    `
      );

      this.lastProgressUpdate = now;
    }
  }

  /**
   * Print final results
   */
  _printResults() {
    const elapsed = (Date.now() - this.startMs) / 1000;
    
    console.log('\n\n=== Backtest Complete ===\n');
    console.log(`Duration: ${elapsed.toFixed(1)} seconds`);
    console.log(`Bars processed: ${this.barCount.toLocaleString()}`);
    console.log(`Speed: ${Math.round(this.barCount / elapsed).toLocaleString()} bars/second`);
    console.log('');
    console.log(`Initial capital: $${this.initialCapital.toLocaleString()}`);
    console.log(`Final equity: $${this.equity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    console.log(`Return: ${((this.equity / this.initialCapital - 1) * 100).toFixed(2)}%`);
    console.log(`Total trades: ${this.trades.length}`);
    
    if (this.trades.length > 0) {
      const winners = this.trades.filter(t => t.pnl > 0);
      const losers = this.trades.filter(t => t.pnl < 0);
      const winRate = (winners.length / this.trades.length * 100).toFixed(1);
      const avgWin = winners.length > 0 
        ? winners.reduce((sum, t) => sum + t.pnl, 0) / winners.length 
        : 0;
      const avgLoss = losers.length > 0 
        ? losers.reduce((sum, t) => sum + t.pnl, 0) / losers.length 
        : 0;
      
      console.log(`Win rate: ${winRate}%`);
      console.log(`Avg win: $${avgWin.toFixed(2)}`);
      console.log(`Avg loss: $${avgLoss.toFixed(2)}`);
    }
  }

  /**
   * Generate a detailed report object
   */
  _generateReport() {
    const elapsed = (Date.now() - this.startMs) / 1000;
    
    return {
      summary: {
        symbol: this.symbol,
        timeframes: this.timeframes,
        startTime: this.startTime,
        endTime: this.endTime,
        barsProcessed: this.barCount,
        durationSeconds: elapsed,
        barsPerSecond: Math.round(this.barCount / elapsed)
      },
      performance: {
        initialCapital: this.initialCapital,
        finalEquity: this.equity,
        returnPct: (this.equity / this.initialCapital - 1) * 100,
        totalTrades: this.trades.length,
        winningTrades: this.trades.filter(t => t.pnl > 0).length,
        losingTrades: this.trades.filter(t => t.pnl < 0).length
      },
      trades: this.trades,
      equityCurve: this.equityCurve
    };
  }
}

module.exports = { BacktestEngine };
