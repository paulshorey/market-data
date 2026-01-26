/**
 * TBBO Aggregator
 *
 * Aggregates real-time TBBO (trade) data into 1-minute OHLCV candles
 * and writes them to the database.
 * 
 * Volume Delta (VD) and Cumulative Volume Delta (CVD):
 * - VD = askVolume - bidVolume (buying pressure - selling pressure)
 * - CVD = running total of VD across all time
 * - Positive VD/CVD = more aggressive buying
 * - Negative VD/CVD = more aggressive selling
 */

import { pool } from "../lib/db.js";

export interface TbboRecord {
  timestamp: string; // Nanosecond epoch timestamp as string (e.g., "1768275460711927889")
  symbol: string; // Specific contract symbol (e.g., "ESH5")
  price: number; // Trade price
  size: number; // Trade size
  side: string; // 'A' (ask) = aggressive buy, 'B' (bid) = aggressive sell, 'N' = unknown
  bidPrice: number; // Best bid at time of trade
  askPrice: number; // Best ask at time of trade
  bidSize: number; // Bid size
  askSize: number; // Ask size
}

interface CandleState {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  askVolume: number; // Volume from trades at ask (side='A') = aggressive buying
  bidVolume: number; // Volume from trades at bid (side='B') = aggressive selling
  unknownSideVolume: number; // Volume from trades with unknown side
  symbol: string; // Most recent symbol (for contract tracking)
  tradeCount: number;
}

// Map: ticker|minuteTimestamp -> CandleState
type CandleMap = Map<string, CandleState>;

// Maximum age (in ms) for a trade to be accepted
// Trades older than this are considered "late" and will be rejected
const MAX_TRADE_AGE_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Extract parent ticker from contract symbol
 * ESH5 -> ES, NQM5 -> NQ, CLZ4 -> CL, etc.
 */
function extractTicker(symbol: string | undefined): string {
  if (!symbol) {
    return "UNKNOWN";
  }
  // Most futures symbols are 2-3 letter ticker + month code + year digit(s)
  // Month codes: F, G, H, J, K, M, N, Q, U, V, X, Z
  const match = symbol.match(/^([A-Z]{1,3})[FGHJKMNQUVXZ]\d+$/);
  return match ? match[1] : symbol;
}

/**
 * Convert nanosecond timestamp to milliseconds
 */
function nsToMs(nsTimestamp: string): number {
  return Math.floor(parseInt(nsTimestamp, 10) / 1_000_000);
}

/**
 * Get the start of the 1-minute bucket for a timestamp
 * @param nsTimestamp - Nanosecond epoch timestamp as string (e.g., "1768275460711927889")
 */
function getMinuteBucket(nsTimestamp: string): string {
  const msTimestamp = nsToMs(nsTimestamp);
  const date = new Date(msTimestamp);
  date.setSeconds(0, 0);
  return date.toISOString();
}

/**
 * Aggregates TBBO records into 1-minute candles
 */
export class TbboAggregator {
  private candles: CandleMap = new Map();
  private recordsProcessed = 0;
  private candlesWritten = 0;
  private lastLogTime = Date.now();
  private initialized = false;

  // Cumulative Volume Delta per ticker - persists across minutes
  // This is the running total of VD that never resets
  private cvdByTicker: Map<string, number> = new Map();

  // Track statistics for monitoring
  private stats = {
    lateTradesRejected: 0,
    unknownSideTrades: 0,
  };

  constructor() {
    console.log("📊 TBBO Aggregator created (call initialize() to load CVD from database)");
  }

  /**
   * Initialize the aggregator by loading last CVD values from database
   * This should be called before processing any trades to ensure CVD continuity
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      console.warn("⚠️ Aggregator already initialized");
      return;
    }

    try {
      // Load the most recent CVD value for each ticker from the database
      const result = await pool.query(`
        SELECT DISTINCT ON (ticker) ticker, cvd
        FROM "candles-1m"
        WHERE cvd IS NOT NULL
        ORDER BY ticker, time DESC
      `);

      for (const row of result.rows) {
        const cvd = parseFloat(row.cvd) || 0;
        this.cvdByTicker.set(row.ticker, cvd);
        console.log(`📈 Loaded CVD for ${row.ticker}: ${cvd.toLocaleString()}`);
      }

      this.initialized = true;
      console.log(`✅ TBBO Aggregator initialized with CVD for ${result.rows.length} ticker(s)`);
    } catch (err) {
      // If table doesn't exist or query fails, start fresh
      console.warn("⚠️ Could not load CVD from database, starting fresh:", err);
      this.initialized = true;
    }
  }

  /**
   * Determine trade side using Lee-Ready algorithm as fallback
   * when the side field is unknown or missing.
   * 
   * Lee-Ready algorithm (1991):
   * - If trade price > midpoint of bid/ask spread -> Buy (aggressive buyer)
   * - If trade price < midpoint -> Sell (aggressive seller)
   * - If trade price = midpoint -> Use previous trade direction (tick test)
   * 
   * @returns 'A' for ask (buy), 'B' for bid (sell), or null if undetermined
   */
  private inferSideFromPrice(price: number, bidPrice: number, askPrice: number): 'A' | 'B' | null {
    // Need valid bid/ask to infer
    if (!bidPrice || !askPrice || bidPrice <= 0 || askPrice <= 0) {
      return null;
    }

    const midpoint = (bidPrice + askPrice) / 2;

    if (price > midpoint) {
      return 'A'; // Trade closer to ask = aggressive buy
    } else if (price < midpoint) {
      return 'B'; // Trade closer to bid = aggressive sell
    }

    // Price exactly at midpoint - cannot determine
    return null;
  }

  /**
   * Add a TBBO record to the aggregator
   * @returns true if record was accepted, false if rejected (e.g., too old)
   */
  addRecord(record: TbboRecord): boolean {
    // Reject late-arriving trades to prevent CVD corruption
    const tradeTimeMs = nsToMs(record.timestamp);
    const now = Date.now();
    const ageMs = now - tradeTimeMs;

    if (ageMs > MAX_TRADE_AGE_MS) {
      this.stats.lateTradesRejected++;
      // Log periodically to avoid spam
      if (this.stats.lateTradesRejected <= 5 || this.stats.lateTradesRejected % 100 === 0) {
        console.warn(
          `⚠️ Rejected late trade #${this.stats.lateTradesRejected}: ` +
          `${record.symbol} ${ageMs / 1000}s old (max: ${MAX_TRADE_AGE_MS / 1000}s)`
        );
      }
      return false;
    }

    const ticker = extractTicker(record.symbol);
    const minuteBucket = getMinuteBucket(record.timestamp);
    const key = `${ticker}|${minuteBucket}`;

    // Determine trade side
    // 'A' = trade at ask = aggressive BUY (buyer lifted offer)
    // 'B' = trade at bid = aggressive SELL (seller hit bid)
    let side = record.side;
    let isAsk = side === "A";
    let isBid = side === "B";

    // If side is unknown, try Lee-Ready algorithm
    if (!isAsk && !isBid) {
      const inferredSide = this.inferSideFromPrice(record.price, record.bidPrice, record.askPrice);
      if (inferredSide) {
        side = inferredSide;
        isAsk = side === "A";
        isBid = side === "B";
      } else {
        // Could not determine side - track for monitoring
        this.stats.unknownSideTrades++;
        if (this.stats.unknownSideTrades <= 5 || this.stats.unknownSideTrades % 1000 === 0) {
          console.log(
            `📊 Unknown side trade #${this.stats.unknownSideTrades}: ` +
            `${record.symbol} @ ${record.price} (bid: ${record.bidPrice}, ask: ${record.askPrice})`
          );
        }
      }
    }

    const existing = this.candles.get(key);

    if (existing) {
      // Update existing candle
      existing.high = Math.max(existing.high, record.price);
      existing.low = Math.min(existing.low, record.price);
      existing.close = record.price;
      existing.volume += record.size;
      existing.symbol = record.symbol; // Track latest symbol
      existing.tradeCount++;
      // Track volume by side for Volume Delta calculation
      if (isAsk) {
        existing.askVolume += record.size;
      } else if (isBid) {
        existing.bidVolume += record.size;
      } else {
        existing.unknownSideVolume += record.size;
      }
    } else {
      // Create new candle
      this.candles.set(key, {
        open: record.price,
        high: record.price,
        low: record.price,
        close: record.price,
        volume: record.size,
        askVolume: isAsk ? record.size : 0,
        bidVolume: isBid ? record.size : 0,
        unknownSideVolume: (!isAsk && !isBid) ? record.size : 0,
        symbol: record.symbol,
        tradeCount: 1,
      });
    }

    this.recordsProcessed++;

    // Log progress every 30 seconds
    if (Date.now() - this.lastLogTime > 30000) {
      this.logStatus();
      this.lastLogTime = Date.now();
    }

    return true;
  }

  /**
   * Log current aggregator status
   */
  private logStatus(): void {
    const unknownPct = this.recordsProcessed > 0 
      ? ((this.stats.unknownSideTrades / this.recordsProcessed) * 100).toFixed(1)
      : '0';
    
    console.log(
      `📊 Aggregator: ${this.recordsProcessed.toLocaleString()} trades → ` +
        `${this.candles.size} pending candles, ` +
        `${this.candlesWritten.toLocaleString()} written | ` +
        `Unknown side: ${unknownPct}%, Late rejected: ${this.stats.lateTradesRejected}`,
    );
  }

  /**
   * Flush completed candles (older than current minute) to database
   * and save in-progress candles without clearing them.
   * 
   * This allows us to update the database every 10 seconds while
   * continuing to aggregate within the same minute.
   * 
   * CVD handling:
   * - For completed candles: Add VD to CVD running total permanently
   * - For in-progress candles: Calculate CVD but don't update running total yet
   */
  async flushCompleted(): Promise<void> {
    const now = new Date();
    now.setSeconds(0, 0);
    const currentMinute = now.toISOString();

    const toFlushCompleted: Array<{ key: string; ticker: string; time: string; candle: CandleState }> = [];
    const toSaveInProgress: Array<{ key: string; ticker: string; time: string; candle: CandleState }> = [];

    for (const [key, candle] of this.candles) {
      const [ticker, time] = key.split("|");
      if (time < currentMinute) {
        // Completed minute - will be removed after writing
        toFlushCompleted.push({ key, ticker, time, candle });
      } else {
        // In-progress minute - save but don't remove
        toSaveInProgress.push({ key, ticker, time, candle });
      }
    }

    // Write completed candles and remove them from memory
    // Also permanently update CVD running total for completed candles
    if (toFlushCompleted.length > 0) {
      const writeSuccess = await this.writeCandlesToDb(toFlushCompleted);
      
      if (writeSuccess) {
        // Only update CVD and delete candles if DB write succeeded
        for (const { key, ticker, candle } of toFlushCompleted) {
          const vd = candle.askVolume - candle.bidVolume;
          const currentCvd = this.cvdByTicker.get(ticker) || 0;
          this.cvdByTicker.set(ticker, currentCvd + vd);
          this.candles.delete(key);
        }
        console.log(`✅ Flushed ${toFlushCompleted.length} completed candle(s)`);
      } else {
        console.warn(`⚠️ Keeping ${toFlushCompleted.length} candle(s) in memory - will retry next flush`);
      }
    }

    // Save in-progress candles but keep them in memory for continued aggregation
    // CVD is calculated but not permanently updated until minute completes
    if (toSaveInProgress.length > 0) {
      await this.writeCandlesToDb(toSaveInProgress);
      console.log(`🔄 Saved ${toSaveInProgress.length} in-progress candle(s)`);
    }
  }

  /**
   * Flush ALL candles (used during shutdown)
   */
  async flushAll(): Promise<void> {
    if (this.candles.size === 0) return;

    const toFlush: Array<{ key: string; ticker: string; time: string; candle: CandleState }> = [];

    for (const [key, candle] of this.candles) {
      const [ticker, time] = key.split("|");
      toFlush.push({ key, ticker, time, candle });
    }

    const writeSuccess = await this.writeCandlesToDb(toFlush);

    if (writeSuccess) {
      // Update CVD running totals for all flushed candles
      for (const { ticker, candle } of toFlush) {
        const vd = candle.askVolume - candle.bidVolume;
        const currentCvd = this.cvdByTicker.get(ticker) || 0;
        this.cvdByTicker.set(ticker, currentCvd + vd);
      }
      this.candles.clear();
      console.log(`🔄 Flushed all ${toFlush.length} pending candles`);
    } else {
      console.error(`❌ Failed to flush ${toFlush.length} candles on shutdown - data may be lost`);
    }
  }

  /**
   * Write candles to database using batch upsert
   * 
   * For in-progress candles (updated every 10 seconds within the same minute):
   * - Always update when new volume >= existing (accumulating trades)
   * - Merge high/low to capture the full range
   * - Keep original open, use latest close
   * 
   * Volume Delta (VD) = askVolume - bidVolume for this minute (resets each minute)
   * Cumulative Volume Delta (CVD) = running total of VD across all time
   * 
   * @returns true if write succeeded, false if failed
   */
  private async writeCandlesToDb(candles: Array<{ ticker: string; time: string; candle: CandleState }>): Promise<boolean> {
    if (candles.length === 0) return true;

    try {
      // Sort candles by ticker, then by time to ensure correct CVD calculation
      // when multiple minutes for the same ticker are in the same batch
      const sortedCandles = [...candles].sort((a, b) => {
        if (a.ticker !== b.ticker) return a.ticker.localeCompare(b.ticker);
        return a.time.localeCompare(b.time);
      });

      // Build batch insert with UPSERT
      const values: (string | number)[] = [];
      const placeholders: string[] = [];

      // Track running CVD per ticker within this batch
      // This handles the case where multiple completed minutes for the same ticker
      // are written in one batch (e.g., after a failed flush retry)
      const batchCvd: Map<string, number> = new Map();

      sortedCandles.forEach(({ ticker, time, candle }, i) => {
        // Calculate Volume Delta for this minute: Ask volume - Bid volume
        // Note: unknownSideVolume is NOT included in VD calculation
        const vd = candle.askVolume - candle.bidVolume;

        // Get CVD: use batch running total if available, otherwise use stored CVD
        const baseCvd = batchCvd.has(ticker) 
          ? batchCvd.get(ticker)! 
          : (this.cvdByTicker.get(ticker) || 0);
        const cvd = baseCvd + vd;

        // Update batch running total for this ticker
        batchCvd.set(ticker, cvd);

        const offset = i * 10;
        placeholders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, ` +
          `$${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10})`
        );
        values.push(time, ticker, candle.symbol, candle.open, candle.high, candle.low, candle.close, candle.volume, vd, cvd);
      });

      // ON CONFLICT: Update when new volume >= existing (handles in-progress updates)
      // - Keep original open (first trade of the minute)
      // - Merge high/low to capture full range
      // - Use latest close (most recent price)
      // - Use new volume (accumulating)
      // - Update vd and cvd with latest calculated values
      const query = `
        INSERT INTO "candles-1m" (time, ticker, symbol, open, high, low, close, volume, vd, cvd)
        VALUES ${placeholders.join(", ")}
        ON CONFLICT (ticker, time) DO UPDATE SET
          symbol = EXCLUDED.symbol,
          open = "candles-1m".open,
          high = GREATEST("candles-1m".high, EXCLUDED.high),
          low = LEAST("candles-1m".low, EXCLUDED.low),
          close = EXCLUDED.close,
          volume = EXCLUDED.volume,
          vd = EXCLUDED.vd,
          cvd = EXCLUDED.cvd
        WHERE EXCLUDED.volume >= "candles-1m".volume
      `;

      await pool.query(query, values);
      this.candlesWritten += candles.length;
      return true;
    } catch (err) {
      console.error("❌ Failed to write candles:", err);
      return false;
    }
  }

  /**
   * Get aggregator stats
   */
  getStats(): {
    recordsProcessed: number;
    pendingCandles: number;
    candlesWritten: number;
    lateTradesRejected: number;
    unknownSideTrades: number;
    cvdByTicker: Record<string, number>;
  } {
    return {
      recordsProcessed: this.recordsProcessed,
      pendingCandles: this.candles.size,
      candlesWritten: this.candlesWritten,
      lateTradesRejected: this.stats.lateTradesRejected,
      unknownSideTrades: this.stats.unknownSideTrades,
      cvdByTicker: Object.fromEntries(this.cvdByTicker),
    };
  }
}
