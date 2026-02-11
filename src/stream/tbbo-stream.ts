/**
 * Databento Live Streaming Client
 *
 * Connects to Databento's Raw TCP API to receive real-time TBBO (Top of Book on Trade) data.
 * Uses JSON encoding for easier parsing in Node.js.
 *
 * Protocol: https://databento.com/docs/api-reference-live
 * TBBO Schema: https://databento.com/docs/schemas-and-data-formats/tbbo
 */

import { createConnection, Socket } from "net";
import { createHash } from "crypto";
import { Tbbo1mAggregator, TbboRecord } from "./tbbo-1m-aggregator.js";

// Configuration from environment (all required - no defaults)
const DATABENTO_API_KEY = process.env.DATABENTO_API_KEY;
const DATABENTO_DATASET = process.env.DATABENTO_DATASET;
const DATABENTO_SYMBOLS = process.env.DATABENTO_SYMBOLS?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// stype_in: "raw_symbol" for specific contracts (ESH6), "parent" for parent symbols (ES.FUT)
const DATABENTO_STYPE = process.env.DATABENTO_STYPE;

// Reconnection settings
const MAX_RECONNECT_DELAY = 30000;
const INITIAL_RECONNECT_DELAY = 1000;

/**
 * Check if futures market is currently open
 * 
 * Futures market closed hours (all times in UTC):
 * - All days: 22:00 - 22:59 (daily maintenance window)
 * - Friday: 22:00 - 24:00 (weekend close starts)
 * - Saturday: all day (closed)
 * - Sunday: 0:00 - 22:59 (closed until market opens at 23:00)
 * 
 * @returns true if market is open, false if closed
 */
function isFuturesMarketOpen(): boolean {
  const now = new Date();
  const utcDay = now.getUTCDay(); // 0 = Sunday, 5 = Friday, 6 = Saturday
  const utcHour = now.getUTCHours();

  // Saturday: all day closed
  if (utcDay === 6) {
    return false;
  }

  // Sunday: closed 0:00 - 22:59, opens at 23:00
  if (utcDay === 0 && utcHour < 23) {
    return false;
  }

  // Friday: closed from 22:00 onward (until Sunday 23:00)
  if (utcDay === 5 && utcHour >= 22) {
    return false;
  }

  // All other days (Mon-Thu, and Sun after 23:00): closed 22:00 - 22:59
  if (utcHour === 22) {
    return false;
  }

  return true;
}

// Track skipped records due to market closed
let skippedMarketClosed = 0;
let lastMarketClosedLogTime = 0;

interface StreamState {
  socket: Socket | null;
  buffer: Buffer;
  authenticated: boolean;
  sessionStarted: boolean;
  reconnectAttempts: number;
  shouldReconnect: boolean;
  aggregator: Tbbo1mAggregator | null;
}

const state: StreamState = {
  socket: null,
  buffer: Buffer.alloc(0),
  authenticated: false,
  sessionStarted: false,
  reconnectAttempts: 0,
  shouldReconnect: true,
  aggregator: null,
};

/**
 * Generate hostname from dataset
 * e.g., GLBX.MDP3 → glbx-mdp3.lsg.databento.com
 */
function getHost(dataset: string): string {
  return `${dataset.toLowerCase().replace(".", "-")}.lsg.databento.com`;
}

/**
 * Parse control message (pipe-delimited key=value pairs)
 */
function parseControlMessage(message: string): Record<string, string> {
  const fields: Record<string, string> = {};
  message.split("|").forEach((pair) => {
    const eqIndex = pair.indexOf("=");
    if (eqIndex > 0) {
      const key = pair.slice(0, eqIndex);
      const value = pair.slice(eqIndex + 1);
      fields[key] = value;
    }
  });
  return fields;
}

/**
 * CRAM authentication: SHA256(challenge + '|' + apiKey) + '-' + bucketId
 */
function computeAuthResponse(cram: string, apiKey: string): string {
  const bucketId = apiKey.slice(-5); // Last 5 chars of API key
  const toHash = `${cram}|${apiKey}`;
  const hash = createHash("sha256").update(toHash).digest("hex");
  return `${hash}-${bucketId}`;
}

/**
 * Handle incoming control messages during connection/auth phase
 */
function handleControlMessage(message: string): void {
  const fields = parseControlMessage(message);

  // Log raw control message for debugging
  console.log(`🔹 Control message: ${message.substring(0, 200)}${message.length > 200 ? "..." : ""}`);

  if (fields.lsg_version) {
    console.log(`📡 Connected to Databento gateway v${fields.lsg_version}`);
    // Wait for challenge
  } else if (fields.cram) {
    // Challenge received - send authentication
    if (!DATABENTO_API_KEY || !DATABENTO_DATASET) {
      console.error("❌ Cannot authenticate: missing API key or dataset");
      state.socket?.end();
      return;
    }
    console.log("🔐 Received challenge, authenticating...");
    const authResponse = computeAuthResponse(fields.cram, DATABENTO_API_KEY);

    // Use JSON encoding for easier parsing
    const authMsg = `auth=${authResponse}|dataset=${DATABENTO_DATASET}|encoding=json|ts_out=1\n`;
    console.log(`🔐 Sending auth: dataset=${DATABENTO_DATASET}, encoding=json`);
    state.socket?.write(authMsg);
  } else if (fields.success !== undefined) {
    if (fields.success === "1") {
      state.authenticated = true;
      state.reconnectAttempts = 0;
      console.log(`✅ Authenticated! Session ID: ${fields.session_id}`);

      // Subscribe to TBBO for configured symbols
      subscribe();
    } else {
      console.error(`❌ Authentication failed!`);
      console.error(`   Error: ${fields.error || "Unknown error"}`);
      console.error(`   Check your DATABENTO_API_KEY is valid`);
      state.shouldReconnect = false; // Don't reconnect on auth failure
      state.socket?.end();
    }
  } else if (fields.error) {
    console.error(`❌ Server error: ${fields.error}`);
  } else {
    // Unknown control message - log it for debugging
    console.log(`🔸 Unknown control message fields:`, fields);
  }
}

/**
 * Subscribe to TBBO schema for configured symbols
 */
function subscribe(): void {
  if (!state.socket || !DATABENTO_SYMBOLS || !DATABENTO_STYPE) return;

  // Subscribe to TBBO (Top of Book on Trade)
  // stype_in: "raw_symbol" for specific contracts (ESH6), "parent" for parent symbols (ES.FUT)
  const subscribeMsg = `schema=tbbo|stype_in=${DATABENTO_STYPE}|symbols=${DATABENTO_SYMBOLS.join(",")}\n`;
  state.socket.write(subscribeMsg);
  console.log(`📊 Subscribed to TBBO: ${DATABENTO_SYMBOLS.join(", ")} (stype: ${DATABENTO_STYPE})`);

  // Start the session to begin receiving data
  state.socket.write("start_session=1\n");
  state.sessionStarted = true;
  console.log("🚀 Session started - streaming TBBO data...");
}

/**
 * Parse a TBBO JSON record from Databento
 *
 * Real-time streaming uses fixed-point integers for prices (multiply by 1e-9).
 * The bid/ask data is in the levels[0] array, similar to historical data.
 *
 * Expected JSON structure (see logged output for actual format):
 * {
 *   "hd": { "ts_event": "1234567890123456789", "rtype": 1, "publisher_id": 1, "instrument_id": 1234 },
 *   "price": 6913500000000,       // Fixed-point price (× 1e-9 = 6913.50)
 *   "size": 5,                    // Trade size
 *   "action": "T",                // Trade action
 *   "side": "A",                  // Aggressor side: "A" (ask/buy), "B" (bid/sell), "N" (unknown)
 *   "flags": 0,
 *   "depth": 0,
 *   "ts_recv": "1234567890123456789",
 *   "ts_in_delta": 0,
 *   "sequence": 12345,
 *   "levels": [{                  // BBO data in levels array
 *     "bid_px": 6913250000000,    // Fixed-point best bid
 *     "ask_px": 6913750000000,    // Fixed-point best ask
 *     "bid_sz": 100,              // Best bid size
 *     "ask_sz": 150,              // Best ask size
 *     "bid_ct": 10,               // Bid count
 *     "ask_ct": 15                // Ask count
 *   }]
 * }
 *
 * Note: symbol is resolved via instrument_id → symbol mapping (rtype=22 messages)
 */
// Track skipped records for debugging
let skippedNoPrice = 0;
let skippedSpread = 0;
let skippedNoSymbol = 0;
let skippedControlMessages = 0;
let parseErrors = 0;
let rawRecordsLogged = 0;

// Maps: symbol → instrument_id, and instrument_id → symbol
const symbolToInstrumentId: Map<string, number> = new Map();
const instrumentIdToSymbol: Map<number, string> = new Map();

// Databento uses fixed-point pricing with 1e-9 precision
const FIXED_PRICE_SCALE = 1e-9;

// Databento record types (rtype)
const RTYPE = {
  MBP1: 1, // Market by price (level 1) - includes TBBO trades
  SYMBOL_MAPPING: 22, // Maps parent symbol (ES.FUT) to specific contracts (ESH5)
  SUBSCRIPTION_MSG: 23, // Subscription confirmation/error
};

function parseTbboRecord(json: string): TbboRecord | null {
  try {
    const data = JSON.parse(json);
    const rtype = data.hd?.rtype;

    // Handle subscription confirmation
    if (rtype === RTYPE.SUBSCRIPTION_MSG) {
      console.log(`📬 Subscription: ${data.msg || "confirmed"}`);
      skippedControlMessages++;
      return null;
    }

    // Handle symbol mapping - build instrument_id ↔ symbol lookup
    if (rtype === RTYPE.SYMBOL_MAPPING) {
      const symbol = data.stype_out_symbol;
      const instrumentId = data.hd?.instrument_id;
      if (symbol && instrumentId) {
        symbolToInstrumentId.set(symbol, instrumentId);
        instrumentIdToSymbol.set(instrumentId, symbol);
        console.log(`🗺️  Symbol mapping: ${symbol} → instrument_id ${instrumentId}`);
      }
      skippedControlMessages++;
      return null;
    }

    // Log raw JSON for first few actual trade records
    if (rawRecordsLogged < 5 && data.price && data.action === "T") {
      rawRecordsLogged++;
      console.log(`🔍 Raw TBBO #${rawRecordsLogged}:`, JSON.stringify(data));
    }

    // Only process trade actions (action="T")
    if (data.action !== "T") {
      skippedNoPrice++;
      return null;
    }

    // Skip records without price
    const priceRaw = data.price;
    if (!priceRaw || priceRaw === "9223372036854775807") {
      skippedNoPrice++;
      return null;
    }

    // Resolve symbol from instrument_id
    const instrumentId = data.hd?.instrument_id;
    const symbol = instrumentIdToSymbol.get(instrumentId);
    if (!symbol) {
      skippedNoSymbol++;
      return null;
    }

    // Skip spread contracts (e.g., "ESM5-ESU5")
    if (symbol.includes("-")) {
      skippedSpread++;
      return null;
    }

    // Parse prices - Databento uses fixed-point integers (multiply by 1e-9)
    const price = (typeof priceRaw === "number" ? priceRaw : parseFloat(priceRaw)) * FIXED_PRICE_SCALE;

    // Bid/ask are in levels[0] for TBBO
    const level = data.levels?.[0] || {};
    const bidPxRaw = level.bid_px;
    const askPxRaw = level.ask_px;
    const bidPrice = bidPxRaw ? (typeof bidPxRaw === "number" ? bidPxRaw : parseFloat(bidPxRaw)) * FIXED_PRICE_SCALE : 0;
    const askPrice = askPxRaw ? (typeof askPxRaw === "number" ? askPxRaw : parseFloat(askPxRaw)) * FIXED_PRICE_SCALE : 0;

    return {
      timestamp: data.hd?.ts_event || data.ts_recv,
      symbol,
      price,
      size: parseInt(data.size, 10) || 0,
      side: data.side, // 'A' = ask (buy aggressor), 'B' = bid (sell aggressor)
      bidPrice,
      askPrice,
      bidSize: parseInt(level.bid_sz, 10) || 0,
      askSize: parseInt(level.ask_sz, 10) || 0,
    };
  } catch (err) {
    parseErrors++;
    if (parseErrors <= 3 || parseErrors % 100 === 0) {
      console.error(`❌ Parse error #${parseErrors}: ${err}`);
      console.error(`   Raw JSON (first 200 chars): ${json.substring(0, 200)}`);
    }
    return null;
  }
}

/**
 * Get stream statistics (for debugging)
 */
export function getStreamStats(): {
  messagesReceived: number;
  skippedControlMessages: number;
  skippedNoPrice: number;
  skippedNoSymbol: number;
  skippedSpread: number;
  skippedMarketClosed: number;
  parseErrors: number;
  symbolMappings: Record<string, number>;
  marketOpen: boolean;
} {
  return {
    messagesReceived: messageCount,
    skippedControlMessages,
    skippedNoPrice,
    skippedNoSymbol,
    skippedSpread,
    skippedMarketClosed,
    parseErrors,
    symbolMappings: Object.fromEntries(symbolToInstrumentId),
    marketOpen: isFuturesMarketOpen(),
  };
}

// Track message counts for logging
let messageCount = 0;
let lastMessageLogTime = Date.now();

/**
 * Handle incoming data from the socket
 */
function handleData(data: Buffer): void {
  state.buffer = Buffer.concat([state.buffer, data]);

  // Process newline-delimited messages
  while (true) {
    const newlineIndex = state.buffer.indexOf("\n");
    if (newlineIndex === -1) break;

    const message = state.buffer.subarray(0, newlineIndex).toString("utf8");
    state.buffer = state.buffer.subarray(newlineIndex + 1);

    if (!message.trim()) continue;

    // Before session starts, messages are control messages
    if (!state.sessionStarted) {
      handleControlMessage(message);
    } else {
      // After session starts, messages are JSON records
      const record = parseTbboRecord(message);
      if (record && state.aggregator) {
        // Check if futures market is open before processing
        if (!isFuturesMarketOpen()) {
          skippedMarketClosed++;
          // Log market closed status periodically (every 5 minutes)
          const now = Date.now();
          if (now - lastMarketClosedLogTime > 300000) {
            console.log(`🌙 Market closed - skipped ${skippedMarketClosed.toLocaleString()} records`);
            lastMarketClosedLogTime = now;
          }
          return;
        }

        messageCount++;

        // Log first few records to confirm data is flowing
        if (messageCount <= 5) {
          console.log(`📥 TBBO #${messageCount}: ${record.symbol} @ ${record.price} x${record.size} ` + `(bid: ${record.bidPrice}, ask: ${record.askPrice})`);
        }

        // Log periodic summary every 30 seconds
        if (Date.now() - lastMessageLogTime > 30000) {
          console.log(
            `📊 Stream: ${messageCount.toLocaleString()} trades | ` + `${skippedControlMessages} control msgs | ` + `${skippedNoPrice} no-price events`
          );
          lastMessageLogTime = Date.now();
        }

        state.aggregator.addRecord(record);
      }
    }
  }
}

/**
 * Schedule a reconnection attempt with exponential backoff
 */
function scheduleReconnect(): void {
  if (!state.shouldReconnect) {
    console.log("🛑 Reconnection disabled (auth failure or shutdown)");
    return;
  }

  const delay = Math.min(INITIAL_RECONNECT_DELAY * Math.pow(2, state.reconnectAttempts), MAX_RECONNECT_DELAY);
  state.reconnectAttempts++;

  console.log(`🔄 Reconnecting in ${delay}ms (attempt ${state.reconnectAttempts})...`);
  setTimeout(() => connect(), delay);
}

/**
 * Connect to Databento streaming gateway
 */
function connect(): void {
  // Config already validated in startDatabentoStream, but be defensive
  if (!DATABENTO_API_KEY || !DATABENTO_DATASET) {
    console.warn("⚠️ Databento config not set, streaming disabled");
    return;
  }

  const host = getHost(DATABENTO_DATASET);
  const port = 13000;

  console.log(`🔌 Connecting to ${host}:${port}...`);

  // Reset state for new connection
  state.buffer = Buffer.alloc(0);
  state.authenticated = false;
  state.sessionStarted = false;

  state.socket = createConnection({ host, port });

  state.socket.on("connect", () => {
    console.log("✅ TCP connection established");
  });

  state.socket.on("data", handleData);

  state.socket.on("error", (err: NodeJS.ErrnoException) => {
    console.error("═".repeat(50));
    console.error("❌ SOCKET ERROR");
    console.error("═".repeat(50));
    console.error(`   Message: ${err.message}`);
    console.error(`   Code: ${err.code || "N/A"}`);
    console.error(`   Errno: ${err.errno || "N/A"}`);
    if (err.code === "ENOTFOUND") {
      console.error(`   → DNS resolution failed. Check hostname.`);
    } else if (err.code === "ECONNREFUSED") {
      console.error(`   → Connection refused. Server may be down.`);
    } else if (err.code === "ETIMEDOUT") {
      console.error(`   → Connection timed out. Network issue.`);
    }
    console.error("═".repeat(50));
  });

  state.socket.on("close", (hadError: boolean) => {
    console.log(`🔌 Connection closed${hadError ? " (with error)" : ""}`);
    state.socket = null;
    state.authenticated = false;
    state.sessionStarted = false;

    // Flush any pending candles before reconnecting
    state.aggregator?.flushAll();

    scheduleReconnect();
  });

  state.socket.on("timeout", () => {
    console.warn("═".repeat(50));
    console.warn("⚠️ SOCKET TIMEOUT");
    console.warn("═".repeat(50));
    console.warn("   No data received for 60 seconds.");
    console.warn("   This could mean:");
    console.warn("   - Market is closed (no trades occurring)");
    console.warn("   - Connection issue");
    console.warn("   - Subscription problem");
    console.warn("   Closing connection to trigger reconnect...");
    console.warn("═".repeat(50));
    state.socket?.end();
  });

  // Set a 60 second timeout for idle connections
  state.socket.setTimeout(60000);
}

/**
 * Validate required environment variables
 * Returns error message if validation fails, null if OK
 */
function validateConfig(): string | null {
  const missing: string[] = [];

  if (!DATABENTO_API_KEY) missing.push("DATABENTO_API_KEY");
  if (!DATABENTO_DATASET) missing.push("DATABENTO_DATASET");
  if (!DATABENTO_SYMBOLS || DATABENTO_SYMBOLS.length === 0) missing.push("DATABENTO_SYMBOLS");
  if (!DATABENTO_STYPE) missing.push("DATABENTO_STYPE");

  if (missing.length > 0) {
    return `Missing required environment variables: ${missing.join(", ")}`;
  }

  // Validate stype is one of the allowed values (DATABENTO_STYPE is guaranteed non-null here)
  if (!["raw_symbol", "parent"].includes(DATABENTO_STYPE!)) {
    return `Invalid DATABENTO_STYPE: "${DATABENTO_STYPE}". Must be "raw_symbol" or "parent"`;
  }

  return null;
}

/**
 * Start the Databento streaming client
 */
export async function startDatabentoStream(): Promise<void> {
  // Validate configuration before starting
  const configError = validateConfig();
  if (configError) {
    console.error("═".repeat(50));
    console.error("❌ Databento Stream Configuration Error");
    console.error("═".repeat(50));
    console.error(`   ${configError}`);
    console.error("");
    console.error("   Required environment variables:");
    console.error("   - DATABENTO_API_KEY: Your Databento API key");
    console.error("   - DATABENTO_DATASET: e.g., GLBX.MDP3 (CME Globex)");
    console.error("   - DATABENTO_SYMBOLS: e.g., ESH6 or ESH6,NQH6");
    console.error("   - DATABENTO_STYPE: raw_symbol or parent");
    console.error("═".repeat(50));
    return; // Don't start the stream
  }

  const host = getHost(DATABENTO_DATASET!);
  const apiKeyPreview = `${DATABENTO_API_KEY!.slice(0, 6)}...${DATABENTO_API_KEY!.slice(-5)}`;

  console.log("═".repeat(50));
  console.log("📡 Starting Databento Live Stream");
  console.log("═".repeat(50));
  console.log(`   Host: ${host}:13000`);
  console.log(`   Dataset: ${DATABENTO_DATASET}`);
  console.log(`   Symbols: ${DATABENTO_SYMBOLS!.join(", ")}`);
  console.log(`   Symbol Type: ${DATABENTO_STYPE}`);
  console.log(`   Schema: TBBO (Top of Book on Trade)`);
  console.log(`   API Key: ${apiKeyPreview}`);
  console.log("═".repeat(50));

  // Initialize the rolling 1-minute aggregator (writes candles to candles_1m)
  // This loads the last CVD values from the database to ensure continuity
  state.aggregator = new Tbbo1mAggregator();
  await state.aggregator.initialize();

  // Start periodic flush (every 1 second to keep database current)
  setInterval(() => {
    state.aggregator?.flushCompleted();
  }, 1000);

  // Log status every 60 seconds if streaming but no trades
  setInterval(() => {
    if (state.sessionStarted && messageCount === 0) {
      console.log("⏳ Stream connected, waiting for trades... (market may be closed)");
      const symbols = Array.from(instrumentIdToSymbol.values());
      console.log(`   Symbol mappings received: ${symbols.length > 0 ? symbols.join(", ") : "none"}`);
    }
  }, 60000);

  connect();
}

/**
 * Stop the Databento streaming client
 */
export function stopDatabentoStream(): void {
  console.log("🛑 Stopping Databento stream...");
  state.shouldReconnect = false;

  // Flush all pending candles
  state.aggregator?.flushAll();

  if (state.socket) {
    state.socket.end();
    state.socket = null;
  }
}

/**
 * Get stream status for health checks
 */
export function getStreamStatus(): {
  connected: boolean;
  authenticated: boolean;
  streaming: boolean;
  reconnectAttempts: number;
} {
  return {
    connected: state.socket !== null && !state.socket.destroyed,
    authenticated: state.authenticated,
    streaming: state.sessionStarted,
    reconnectAttempts: state.reconnectAttempts,
  };
}
