# Databento Live Streaming

> **Implemented in:** `src/stream/tbbo-stream.ts` (production client with reconnection, JSON encoding, market hours detection)

Reference implementation for connecting to the Databento Raw TCP API from Node.js.

API docs: https://databento.com/docs/api-reference-live
TBBO schema: https://databento.com/docs/schemas-and-data-formats/tbbo

## Reference: Raw TCP API in Node.js

Databento doesn't have an official Node.js client, but their Raw API is language-agnostic. Here's a complete implementation:

```javascript
const net = require("net");
const crypto = require("crypto");
const zlib = require("zlib");

class DatabentoLiveClient {
  constructor(apiKey, dataset = "GLBX.MDP3") {
    this.apiKey = apiKey;
    this.dataset = dataset;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.authenticated = false;
    this.sessionStarted = false;
  }

  // Generate hostname from dataset (e.g., GLBX.MDP3 → glbx-mdp3.lsg.databento.com)
  getHost() {
    return `${this.dataset.toLowerCase().replace(".", "-")}.lsg.databento.com`;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection({
        host: this.getHost(),
        port: 13000,
      });

      this.socket.on("connect", () => {
        console.log("Connected to Databento gateway");
      });

      this.socket.on("data", (data) => {
        this.handleData(data, resolve, reject);
      });

      this.socket.on("error", reject);
      this.socket.on("close", () => console.log("Connection closed"));
    });
  }

  handleData(data, resolve, reject) {
    this.buffer = Buffer.concat([this.buffer, data]);

    // Process text control messages (newline-delimited)
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) break;

      const message = this.buffer.slice(0, newlineIndex).toString("ascii");
      this.buffer = this.buffer.slice(newlineIndex + 1);

      this.handleControlMessage(message, resolve, reject);
    }

    // After session starts, remaining buffer is binary DBN data
    if (this.sessionStarted && this.buffer.length > 0) {
      this.handleDbnData(this.buffer);
      this.buffer = Buffer.alloc(0);
    }
  }

  handleControlMessage(message, resolve, reject) {
    const fields = this.parseControlMessage(message);
    console.log("Received:", fields);

    if (fields.lsg_version) {
      // Greeting message - wait for challenge
    } else if (fields.cram) {
      // Challenge request - send authentication
      this.authenticate(fields.cram);
    } else if (fields.success !== undefined) {
      if (fields.success === "1") {
        this.authenticated = true;
        console.log(`Authenticated! Session ID: ${fields.session_id}`);
        resolve(this);
      } else {
        reject(new Error(`Authentication failed: ${fields.error}`));
      }
    }
  }

  parseControlMessage(message) {
    const fields = {};
    message.split("|").forEach((pair) => {
      const [key, value] = pair.split("=");
      if (key) fields[key] = value;
    });
    return fields;
  }

  // CRAM authentication: SHA256(challenge + '|' + apiKey)
  authenticate(cram) {
    const bucketId = this.apiKey.slice(-5); // Last 5 chars of API key
    const toHash = `${cram}|${this.apiKey}`;
    const hash = crypto.createHash("sha256").update(toHash).digest("hex");
    const authResponse = `${hash}-${bucketId}`;

    const authMsg = `auth=${authResponse}|dataset=${this.dataset}|encoding=dbn|ts_out=0\n`;
    this.socket.write(authMsg);
  }

  subscribe(options) {
    const { schema, symbols, stypeIn = "raw_symbol", start } = options;

    let msg = `schema=${schema}|stype_in=${stypeIn}|symbols=${symbols.join(",")}`;
    if (start) msg += `|start=${start}`;
    msg += "\n";

    this.socket.write(msg);
    console.log("Subscribed:", msg.trim());
  }

  startSession() {
    this.socket.write("start_session=1\n");
    this.sessionStarted = true;
    console.log("Session started - streaming data...");
  }

  handleDbnData(buffer) {
    // DBN is a binary format - you'll need to parse the metadata header
    // and fixed-width record structs. See https://github.com/databento/dbn
    //
    // For simplicity, use JSON encoding instead (set encoding=json in auth)
    // or use a library like databento-dbn (Python bindings exist)
    console.log(`Received ${buffer.length} bytes of DBN data`);
  }

  close() {
    if (this.socket) {
      this.socket.end();
    }
  }
}

// Usage example
async function main() {
  const client = new DatabentoLiveClient(
    process.env.DATABENTO_API_KEY,
    "GLBX.MDP3", // CME Globex
  );

  try {
    await client.connect();

    // Subscribe to ES futures trades
    client.subscribe({
      schema: "trades",
      symbols: ["ES.FUT"],
      stypeIn: "parent",
    });

    // Start receiving data
    client.startSession();

    // Keep alive for demo
    setTimeout(() => client.close(), 60000);
  } catch (error) {
    console.error("Error:", error);
  }
}

main();
```

## Key Protocol Details

**Connection**: `{dataset}.lsg.databento.com:13000` (e.g., `glbx-mdp3.lsg.databento.com`)

**Authentication flow**:

1. Gateway sends greeting: `lsg_version=X.X.X\n`
2. Gateway sends challenge: `cram=<random_string>\n`
3. Client computes: `SHA256(cram + "|" + api_key)` + `-` + last 5 chars of API key
4. Client sends: `auth=<response>|dataset=GLBX.MDP3|encoding=dbn\n`

**Subscription**: `schema=trades|stype_in=raw_symbol|symbols=ES.FUT\n`

**Start session**: `start_session=1\n`

## Parsing DBN (Binary Format)

For production use, you'll need to parse DBN records. Consider:

1. **Use JSON encoding** (easier but slower): Set `encoding=json` in auth
2. **Port the Rust/C DBN library**: The [dbn repo](https://github.com/databento/dbn) has the full spec
3. **Use a community library**: Check npm for `databento` packages

The DBN format uses fixed-width structs - for example, a trade record is 72 bytes with fields like `ts_event` (8 bytes), `price` (8 bytes as fixed-point), `size` (4 bytes), etc.
