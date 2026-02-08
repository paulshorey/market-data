/**
 * TimeframeBuffer
 * 
 * Manages a rolling window of OHLCV + indicator data for a single timeframe.
 * Loads data in chunks from the database and provides a sliding window view.
 * 
 * Memory-efficient: only keeps (windowSize + bufferSize) rows in memory,
 * not the entire dataset.
 */

const WINDOW_SIZE = 5000;     // Bars available to strategy (TradingView standard)
const BUFFER_SIZE = 50000;    // Pre-loaded future bars
const REFILL_THRESHOLD = 10000; // Refill when buffer drops below this

class TimeframeBuffer {
  /**
   * @param {object} config
   * @param {number} config.timeframe - Timeframe in minutes (1, 60, 1440, etc.)
   * @param {string} config.symbol - Trading symbol
   * @param {object} config.pool - PostgreSQL connection pool
   * @param {number} [config.windowSize=5000] - Bars available to strategy
   * @param {number} [config.bufferSize=50000] - Pre-loaded future bars
   */
  constructor(config) {
    this.timeframe = config.timeframe;
    this.symbol = config.symbol;
    this.pool = config.pool;
    this.tableName = `ohlcv_${config.timeframe}m`;
    
    this.windowSize = config.windowSize || WINDOW_SIZE;
    this.bufferSize = config.bufferSize || BUFFER_SIZE;
    this.refillThreshold = config.refillThreshold || REFILL_THRESHOLD;

    // The data store - a simple array that we'll slice into window views
    // Structure: [...windowData (oldest)..., currentBar, ...bufferData (newest)...]
    this.data = [];
    
    // Current position in the data array (points to "current" bar)
    // Window is data[position - windowSize + 1] to data[position]
    this.position = -1;
    
    // Track what we've loaded from DB
    this.lastLoadedTs = null;
    this.exhausted = false;  // True when no more data in DB
    
    // Column selection - what fields to load
    this.columns = [
      'ts', 'minute_index', 'open', 'high', 'low', 'close', 'volume',
      'window_complete', 'rsi_14'
      // Add more indicator columns as needed
    ];
  }

  /**
   * Initialize the buffer by loading initial data
   * @param {Date|string} startTime - Start from this timestamp
   * @returns {Promise<boolean>} - True if enough data loaded
   */
  async initialize(startTime) {
    const totalNeeded = this.windowSize + this.bufferSize;
    
    console.log(`  [${this.tableName}] Loading initial ${totalNeeded.toLocaleString()} rows...`);
    
    const result = await this.pool.query(`
      SELECT ${this.columns.join(', ')}
      FROM ${this.tableName}
      WHERE symbol = $1 AND ts >= $2
      ORDER BY ts ASC
      LIMIT $3
    `, [this.symbol, startTime, totalNeeded]);

    if (result.rows.length < this.windowSize) {
      console.warn(`  [${this.tableName}] Not enough data: ${result.rows.length} < ${this.windowSize}`);
      return false;
    }

    // Convert rows to lightweight objects
    this.data = result.rows.map(row => this._parseRow(row));
    this.position = this.windowSize - 1;  // Start at end of first window
    this.lastLoadedTs = this.data[this.data.length - 1].ts;
    this.exhausted = result.rows.length < totalNeeded;

    console.log(`  [${this.tableName}] Loaded ${result.rows.length.toLocaleString()} rows, ` +
                `buffer has ${this.remainingBuffer()} future bars`);

    return true;
  }

  /**
   * Parse a database row into a lightweight object
   */
  _parseRow(row) {
    return {
      ts: row.ts,
      minuteIndex: row.minute_index,
      open: parseFloat(row.open),
      high: parseFloat(row.high),
      low: parseFloat(row.low),
      close: parseFloat(row.close),
      volume: parseFloat(row.volume),
      windowComplete: row.window_complete,
      rsi14: row.rsi_14 ? parseFloat(row.rsi_14) : null,
      // Add more indicators here as needed
    };
  }

  /**
   * Get the current bar (the one being evaluated)
   */
  current() {
    return this.data[this.position];
  }

  /**
   * Get the current window (past windowSize bars including current)
   * This is what the strategy sees
   * 
   * Returns newest bar at index [windowSize - 1], oldest at [0]
   */
  window() {
    const start = Math.max(0, this.position - this.windowSize + 1);
    return this.data.slice(start, this.position + 1);
  }

  /**
   * Get a specific bar from the window
   * @param {number} barsAgo - 0 = current, 1 = previous, etc.
   */
  get(barsAgo = 0) {
    const index = this.position - barsAgo;
    if (index < 0 || index >= this.data.length) {
      return null;
    }
    return this.data[index];
  }

  /**
   * Get an array of a specific field from the window
   * Useful for indicator calculations
   * @param {string} field - Field name ('close', 'rsi14', etc.)
   * @param {number} [length] - Number of bars (default: full window)
   */
  series(field, length = this.windowSize) {
    const result = [];
    const actualLength = Math.min(length, this.position + 1);
    
    for (let i = actualLength - 1; i >= 0; i--) {
      const bar = this.get(i);
      if (bar) {
        result.push(bar[field]);
      }
    }
    
    return result;  // Oldest first, newest last
  }

  /**
   * How many future bars are buffered
   */
  remainingBuffer() {
    return this.data.length - this.position - 1;
  }

  /**
   * Advance to the next bar
   * @returns {boolean} - True if advanced, false if no more data
   */
  advance() {
    if (this.position >= this.data.length - 1) {
      return false;  // No more data
    }
    
    this.position++;
    return true;
  }

  /**
   * Check if buffer needs refilling
   */
  needsRefill() {
    return !this.exhausted && this.remainingBuffer() < this.refillThreshold;
  }

  /**
   * Refill the buffer with more data from the database
   * Also trims old data that's no longer in the window
   */
  async refill() {
    if (this.exhausted) {
      return 0;
    }

    // Load more data
    const result = await this.pool.query(`
      SELECT ${this.columns.join(', ')}
      FROM ${this.tableName}
      WHERE symbol = $1 AND ts > $2
      ORDER BY ts ASC
      LIMIT $3
    `, [this.symbol, this.lastLoadedTs, this.bufferSize]);

    if (result.rows.length === 0) {
      this.exhausted = true;
      return 0;
    }

    // Append new data
    const newRows = result.rows.map(row => this._parseRow(row));
    this.data.push(...newRows);
    this.lastLoadedTs = newRows[newRows.length - 1].ts;

    if (result.rows.length < this.bufferSize) {
      this.exhausted = true;
    }

    // Trim old data (keep some padding for safety)
    const trimPoint = this.position - this.windowSize - 1000;
    if (trimPoint > 0) {
      this.data.splice(0, trimPoint);
      this.position -= trimPoint;
    }

    return result.rows.length;
  }

  /**
   * Check if we've reached the end of available data
   */
  isExhausted() {
    return this.exhausted && this.position >= this.data.length - 1;
  }

  /**
   * Get memory usage estimate
   */
  memoryUsage() {
    // Rough estimate: 100 bytes per row
    return this.data.length * 100;
  }
}

module.exports = { TimeframeBuffer, WINDOW_SIZE, BUFFER_SIZE };
