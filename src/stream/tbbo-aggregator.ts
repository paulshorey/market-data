/**
 * TBBO Aggregator
 *
 * Aggregates real-time TBBO (trade) data into 1-minute OHLCV candles
 * and writes them to the database.
 */

import { pool } from "../lib/db.js";

export interface TbboRecord {
  timestamp: string; // Nanosecond epoch timestamp as string (e.g., "1768275460711927889")
  symbol: string; // Specific contract symbol (e.g., "ESH5")
  price: number; // Trade price
  size: number; // Trade size
  side: string; // 'A' (ask/sell) or 'B' (bid/buy)
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
  symbol: string; // Most recent symbol (for contract tracking)
  tradeCount: number;
}

// Map: ticker|minuteTimestamp -> CandleState
type CandleMap = Map<string, CandleState>;

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
 * Get the start of the 1-minute bucket for a timestamp
 * @param nsTimestamp - Nanosecond epoch timestamp as string (e.g., "1768275460711927889")
 */
function getMinuteBucket(nsTimestamp: string): string {
  // Convert nanoseconds to milliseconds (divide by 1,000,000)
  const msTimestamp = Math.floor(parseInt(nsTimestamp, 10) / 1_000_000);
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

  constructor() {
    console.log("📊 TBBO Aggregator initialized");
  }

  /**
   * Add a TBBO record to the aggregator
   */
  addRecord(record: TbboRecord): void {
    const ticker = extractTicker(record.symbol);
    const minuteBucket = getMinuteBucket(record.timestamp);
    const key = `${ticker}|${minuteBucket}`;

    const existing = this.candles.get(key);

    if (existing) {
      // Update existing candle
      existing.high = Math.max(existing.high, record.price);
      existing.low = Math.min(existing.low, record.price);
      existing.close = record.price;
      existing.volume += record.size;
      existing.symbol = record.symbol; // Track latest symbol
      existing.tradeCount++;
    } else {
      // Create new candle
      this.candles.set(key, {
        open: record.price,
        high: record.price,
        low: record.price,
        close: record.price,
        volume: record.size,
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
  }

  /**
   * Log current aggregator status
   */
  private logStatus(): void {
    console.log(
      `📊 Aggregator: ${this.recordsProcessed.toLocaleString()} trades → ` +
        `${this.candles.size} pending candles, ` +
        `${this.candlesWritten.toLocaleString()} written`,
    );
  }

  /**
   * Flush completed candles (older than current minute) to database
   * and save in-progress candles without clearing them.
   * 
   * This allows us to update the database every 10 seconds while
   * continuing to aggregate within the same minute.
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
    if (toFlushCompleted.length > 0) {
      await this.writeCandlesToDb(toFlushCompleted);
      for (const { key } of toFlushCompleted) {
        this.candles.delete(key);
      }
      console.log(`✅ Flushed ${toFlushCompleted.length} completed candle(s)`);
    }

    // Save in-progress candles but keep them in memory for continued aggregation
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

    await this.writeCandlesToDb(toFlush);
    this.candles.clear();

    console.log(`🔄 Flushed all ${toFlush.length} pending candles`);
  }

  /**
   * Write candles to database using batch upsert
   * 
   * For in-progress candles (updated every 10 seconds within the same minute):
   * - Always update when new volume >= existing (accumulating trades)
   * - Merge high/low to capture the full range
   * - Keep original open, use latest close
   */
  private async writeCandlesToDb(candles: Array<{ ticker: string; time: string; candle: CandleState }>): Promise<void> {
    if (candles.length === 0) return;

    try {
      // Build batch insert with UPSERT
      const values: (string | number)[] = [];
      const placeholders: string[] = [];

      candles.forEach(({ ticker, time, candle }, i) => {
        const offset = i * 8;
        placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8})`);
        values.push(time, ticker, candle.symbol, candle.open, candle.high, candle.low, candle.close, candle.volume);
      });

      // ON CONFLICT: Update when new volume >= existing (handles in-progress updates)
      // - Keep original open (first trade of the minute)
      // - Merge high/low to capture full range
      // - Use latest close (most recent price)
      // - Use new volume (accumulating)
      const query = `
        INSERT INTO "candles-1m" (time, ticker, symbol, open, high, low, close, volume)
        VALUES ${placeholders.join(", ")}
        ON CONFLICT (ticker, time) DO UPDATE SET
          symbol = EXCLUDED.symbol,
          open = "candles-1m".open,
          high = GREATEST("candles-1m".high, EXCLUDED.high),
          low = LEAST("candles-1m".low, EXCLUDED.low),
          close = EXCLUDED.close,
          volume = EXCLUDED.volume
        WHERE EXCLUDED.volume >= "candles-1m".volume
      `;

      await pool.query(query, values);
      this.candlesWritten += candles.length;
    } catch (err) {
      console.error("❌ Failed to write candles:", err);
      // Don't throw - we'll retry on next flush
    }
  }

  /**
   * Get aggregator stats
   */
  getStats(): { recordsProcessed: number; pendingCandles: number; candlesWritten: number } {
    return {
      recordsProcessed: this.recordsProcessed,
      pendingCandles: this.candles.size,
      candlesWritten: this.candlesWritten,
    };
  }
}
