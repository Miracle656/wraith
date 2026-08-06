# Wraith 👻

[![CI](https://github.com/Miracle656/wraith/actions/workflows/ci.yml/badge.svg)](https://github.com/Miracle656/wraith/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Stellar](https://img.shields.io/badge/Stellar-Soroban-black)](https://stellar.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

> **Soroban incoming token transfer indexer** — fills the gap that Horizon leaves open.

Horizon indexes Classic Stellar operations (payments, path payments) but does **not** index Soroban `transfer` events by recipient address. Wraith polls Stellar RPC `getEvents`, parses CAP-67/SEP-41 token events (`transfer`, `mint`, `burn`, `clawback`), stores them in Postgres, and exposes a REST API to query by address.

***

## How It Works

```mermaid
flowchart TD
    SN["☆ Stellar Network\n(Soroban ledgers, ~5 s each)"]
    RPC["Soroban RPC\ngetEvents"]
    SAFE["fetchEventsSafe\nrpc.ts"]
    BISECT{{"XDR decode\nerror?"}}
    SKIP["Skip bad ledger\nlog warning & advance"]
    DECODE["parseEvents\nSEP-41 / CAP-67 normalisation\nScVal → JS native\ndecoder.ts"]
    DB[("Postgres\nTokenTransfer table\nupsert on eventId\nPrisma — db.ts")]
    STATE["IndexerState row\nlastIndexedLedger"]
    HTTP["Express REST API\napi.ts"]
    WS["WebSocket stream\n/subscribe/:address\nws.ts"]
    C1["REST Clients\ncurl · SDK · dApp"]
    C2["Real-time Clients\nbrowser · bot"]

    SN -->|ledger stream| RPC
    RPC -->|raw contract events| SAFE
    SAFE --> BISECT
    BISECT -- yes --> SKIP
    BISECT -- no --> DECODE
    SKIP -->|advance cursor| STATE
    DECODE -->|TransferRecord batch| DB
    DB --> STATE
    DB --> HTTP
    DB --> WS
    HTTP --> C1
    WS --> C2
```

`startIndexer()` runs an infinite loop, calling `getLatestLedger()` every `POLL_INTERVAL_MS` (default 6 s, ≈ 1 ledger). Each cycle calls `fetchEventsSafe`, which requests a batch of Soroban contract events from the RPC via `getEvents`. `parseEvents` then decodes each raw `ScVal` topic/value pair into a typed `TransferRecord` covering `transfer`, `mint`, `burn`, and `clawback` event types as defined by SEP-41 / CAP-67. `upsertTransfers` bulk-inserts the records via Prisma using `skipDuplicates: true` on `eventId`, making re-indexing overlapping ledger ranges idempotent. The Express REST API and WebSocket server both read exclusively from Postgres, keeping the ingestion and query paths fully independent.

> [!NOTE]
> **Bisection strategy for Protocol 22 XDR errors** — Stellar protocol upgrades occasionally introduce new XDR types that older SDK versions cannot decode (e.g. `ScAddressType` value 3 added in Protocol 22). When `fetchEventsSafe` encounters an XDR decode error on a multi-ledger batch, it **bisects** the ledger range recursively — splitting it into two halves and retrying each — until it isolates the single problematic ledger. That ledger is then skipped with a warning log, and indexing continues from the next ledger. This ensures one bad ledger cannot stall the entire indexer.

***

## Quick Start

### 1. Clone & install

```bash
git clone <repo>
cd wraith
npm install
npx prisma generate
```

### 2. Configure

```bash
cp .env.example .env
```

**Testnet setup** (quick start):

```env
DATABASE_URL="postgresql://wraith:wraith@localhost:5432/wraith"
STELLAR_NETWORK="testnet"
# SOROBAN_RPC_URL is optional on testnet — the default public endpoint is used automatically
SOROBAN_RPC_URL=

START_LEDGER=
CONTRACT_IDS=
PORT=3000
```

**Mainnet setup** (production):

```env
DATABASE_URL="postgresql://wraith:wraith@localhost:5432/wraith"
STELLAR_NETWORK="mainnet"
# Required on mainnet — no free public Soroban RPC exists
SOROBAN_RPC_URL="https://mainnet.stellar.validationcloud.io/v1/<YOUR_API_KEY>"

# Strongly recommended on mainnet: filter to specific contracts to reduce load
CONTRACT_IDS="CTOKEN1...,CTOKEN2..."
START_LEDGER=
PORT=3000
```

> **Tip:** If you omit both `SOROBAN_RPC_URL` and `STELLAR_NETWORK`, Wraith will exit immediately with a clear error explaining what to set.

### 3. Start Postgres

```bash
docker-compose up -d db
```

### 4. Run database migrations

```bash
npx prisma migrate dev --name init
```

### 5. Start Wraith

```bash
# Development (hot reload)
npm run dev

# Production
npm run build && npm start
```

Or run everything via Docker:

```bash
docker-compose up --build
```

***

## API Documentation

### REST API Specification

A complete, production-grade OpenAPI 3.0 specification is generated from the shared Zod schemas used by the API handlers.

- **[openapi.json](./docs/openapi.json)**

You can use this file to explore the API, generate client SDKs, or import it into tools like:

- [Swagger UI](https://swagger.io/tools/swagger-ui/) or [Swagger Editor](https://editor.swagger.io/)
- [Postman](https://www.postman.com/)
- [Redoc](https://redocly.com/redoc/)

### TypeScript / Node.js Library Reference

Browse the complete generated API reference for Wraith's public modules:

- **[TypeDoc API Reference](https://miracle656.github.io/wraith/)**

This includes full JSDoc documentation for all modules, types, and functions.

***

## Usage Examples

Replace `GABC…WXYZ` with a real Stellar address and `http://localhost:3000` with your server's base URL.

### `GET /status` — Health check

```bash
# curl
curl http://localhost:3000/status
```

```js
// fetch
const res = await fetch("http://localhost:3000/status");
const data = await res.json();
console.log(data);

// Expected response
// {
//   "ok": true,
//   "lastIndexedLedger": 51234567,
//   "latestLedger": 51234568,
//   "lagLedgers": 1,
//   "startedAt": "2025-01-01T00:00:00.000Z",
//   "uptimeSeconds": 3600,
//   "totalIndexed": 15000
// }
```

***

### `GET /transfers/incoming/:address` — Incoming transfers

```bash
# curl — all incoming transfers
curl "http://localhost:3000/transfers/incoming/GABCDEFGHIJKLMNOPQRSTUVWXYZ"

# curl — filter by date window and page size
curl "http://localhost:3000/transfers/incoming/GABCDEFGHIJKLMNOPQRSTUVWXYZ?fromDate=2025-01-01T00:00:00Z&limit=10"
```

```js
// fetch
const ADDRESS = "GABCDEFGHIJKLMNOPQRSTUVWXYZ";
const res = await fetch(
  `http://localhost:3000/transfers/incoming/${ADDRESS}?fromDate=2025-01-01T00:00:00Z&limit=10`
);
const data = await res.json();
console.log(data);
```

```js
// axios
import axios from "axios";

const ADDRESS = "GABCDEFGHIJKLMNOPQRSTUVWXYZ";
const { data } = await axios.get(
  `http://localhost:3000/transfers/incoming/${ADDRESS}`,
  {
    params: {
      fromDate: "2025-01-01T00:00:00Z",
      limit: 10,
    },
  }
);
console.log(data);

// Expected response
// {
//   "total": 42,
//   "limit": 10,
//   "offset": 0,
//   "transfers": [
//     {
//       "id": 12345,
//       "contractId": "CB64D3G7SM2RTH6ISYIG4P2IYYD6J2OFR6B",
//       "eventType": "transfer",
//       "fromAddress": "GABCDEFGHIJKLMNOPQRSTUVWXYZ",
//       "toAddress":   "GABCDEFGHIJKLMNOPQRSTUVWXYZ",
//       "amount":        "10000000000",
//       "displayAmount": "1000.0000000",
//       "ledger": 51234567,
//       "ledgerClosedAt": "2025-01-01T12:00:00Z",
//       "txHash": "0000000000000000000000000000000000000000000000000000000000000000",
//       "eventId": "12345-1"
//     }
//   ]
// }
```

***

### `GET /transfers/address/:address` — All transfers (sent & received, merged)

```bash
# curl
curl "http://localhost:3000/transfers/address/GABCDEFGHIJKLMNOPQRSTUVWXYZ"
```

```js
// fetch — with optional token-contract filter
const ADDRESS = "GABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CONTRACT = "CB64D3G7SM2RTH6ISYIG4P2IYYD6J2OFR6B";
const res = await fetch(
  `http://localhost:3000/transfers/address/${ADDRESS}?contractId=${CONTRACT}&limit=20`
);
const data = await res.json();
console.log(data);

// OData-style filters and projections are also supported:
// `http://localhost:3000/transfers/address/${ADDRESS}?$filter=ledger gt 1000 and contains(contractId,'CB64')&$select=contractId,amount&cursor=...`

// Expected response  (same shape as /transfers/incoming — adds "direction" per row)
// {
//   "total": 85,
//   "limit": 20,
//   "offset": 0,
//   "transfers": [
//     {
//       "id": 12345,
//       "contractId": "CB64D3G7SM2RTH6ISYIG4P2IYYD6J2OFR6B",
//       "eventType": "transfer",
//       "fromAddress": "GABCDEFGHIJKLMNOPQRSTUVWXYZ",
//       "toAddress":   "GABCDEFGHIJKLMNOPQRSTUVWXYZ",
//       "amount":        "10000000000",
//       "displayAmount": "1000.0000000",
//       "ledger": 51234567,
//       "ledgerClosedAt": "2025-01-01T12:00:00Z",
//       "txHash": "0000000000000000000000000000000000000000000000000000000000000000",
//       "eventId": "12345-1",
//       "direction": "incoming"
//     }
//   ]
// }
```

***

### `GET /summary/:address` — Token summary

```bash
# curl
curl "http://localhost:3000/summary/GABCDEFGHIJKLMNOPQRSTUVWXYZ"
```

```js
// fetch — narrow to a date window
const ADDRESS = "GABCDEFGHIJKLMNOPQRSTUVWXYZ";
const res = await fetch(
  `http://localhost:3000/summary/${ADDRESS}?fromDate=2025-01-01T00:00:00Z&toDate=2025-01-31T23:59:59Z`
);
const data = await res.json();
console.log(data);

// Expected response
// {
//   "address": "GABCDEFGHIJKLMNOPQRSTUVWXYZ",
//   "window": {
//     "fromDate": "2025-01-01T00:00:00Z",
//     "toDate":   "2025-01-31T23:59:59Z"
//   },
//   "tokens": [
//     {
//       "contractId":          "CB64D3G7SM2RTH6ISYIG4P2IYYD6J2OFR6B",
//       "totalReceived":       "50000000000",
//       "totalSent":           "10000000000",
//       "netFlow":             "40000000000",
//       "displayTotalReceived": "5000.0000000",
//       "displayTotalSent":     "1000.0000000",
//       "displayNetFlow":       "4000.0000000",
//       "txCount": 42
//     }
//   ]
// }
```

***

## API Reference

Base URL: `http://localhost:3000`

### `GET /status`

Indexer health — current ledger, network tip, lag, uptime.

```bash
curl http://localhost:3000/status
```

```json
{
  "ok": true,
  "lastIndexedLedger": 5842100,
  "latestLedger": 5842102,
  "lagLedgers": 2,
  "startedAt": "2025-10-01T10:00:00.000Z",
  "uptimeSeconds": 3600,
  "totalIndexed": 12430
}
```

***

### `GET /transfers/incoming/:address`

All token transfers **received** by an address.

| Param        | Type   | Description                                  |
| ------------ | ------ | -------------------------------------------- |
| `contractId` | string | Filter to a specific token contract (`C...`) |
| `fromLedger` | int    | Inclusive lower ledger bound                 |
| `toLedger`   | int    | Inclusive upper ledger bound                 |
| `limit`      | int    | Page size (max 200, default 50)              |
| `offset`     | int    | Pagination offset                            |

```bash
# All incoming transfers for an address
curl "http://localhost:3000/transfers/incoming/GABC123..."

# Filter to a specific token, last 1000 ledgers
curl "http://localhost:3000/transfers/incoming/GABC123...?contractId=CTOKEN...&fromLedger=5840000&limit=20"
```

***

### `GET /transfers/outgoing/:address`

All token transfers **sent** by an address. Same query params as `/incoming`.

```bash
curl "http://localhost:3000/transfers/outgoing/GABC123..."
```

***

### `GET /transfers/tx/:txHash`

All token events emitted within a transaction.

```bash
curl "http://localhost:3000/transfers/tx/abcdef1234567890..."
```

***

## Environment Variables

| Variable              | Default       | Description                                                                                   |
| --------------------- | ------------- | --------------------------------------------------------------------------------------------- |
| `DATABASE_URL`        | —             | Postgres connection string (required)                                                         |
| `DIRECT_DATABASE_URL` | —             | Direct (non-pooled) Postgres URL — required for Prisma migrations on Supabase                 |
| `STELLAR_NETWORK`     | —             | `testnet` or `mainnet`. Testnet auto-configures the default RPC URL.                          |
| `SOROBAN_RPC_URL`     | *(see below)* | Soroban RPC endpoint. Overrides any network default. Required when `STELLAR_NETWORK=mainnet`. |
| `STELLAR_RPC_URL`     | —             | Backward-compat alias for `SOROBAN_RPC_URL`. Used when `SOROBAN_RPC_URL` is unset.            |
| `HORIZON_URL`         | —             | Optional Horizon endpoint used as a fallback source when RPC is unhealthy.                    |
| `HORIZON_EVENTS_PATH`  | `/events`     | Horizon contract-events path used by the fallback source.                                      |
| `START_LEDGER`        | *(tip)*       | Ledger to start indexing from. Leave blank to resume from DB state or start near the tip.     |
| `POLL_INTERVAL_MS`    | `6000`        | Polling interval in ms (\~1 ledger ≈ 6 s)                                                     |
| `CONTRACT_IDS`        | *(all)*       | Comma-separated token contract IDs to watch. Empty = watch all (very heavy on mainnet)        |
| `EVENTS_BATCH_SIZE`   | `10000`       | Max events per RPC call (Stellar RPC hard-cap is 10 000)                                      |
| `RETENTION_DAYS`      | `30`          | Delete transfers older than N days (keeps DB within free-tier limits)                         |
| `PORT`                | `3000`        | REST API port                                                                                 |

### RPC URL Resolution

Wraith resolves the RPC endpoint in this order and fails fast at startup if nothing is configured:

1. `SOROBAN_RPC_URL` — explicit; always wins
2. `STELLAR_RPC_URL` — backward-compat alias
3. `STELLAR_NETWORK=testnet` → `https://soroban-testnet.stellar.org` (free public endpoint)
4. `STELLAR_NETWORK=mainnet` → **error**: requires explicit `SOROBAN_RPC_URL`
5. Nothing set → **error**: clear message explaining what to configure

### Indexer Source Fallback

If `HORIZON_URL` is set, the indexer checks the RPC source first and switches to Horizon when the RPC health check fails. It switches back automatically once RPC becomes healthy again.

### Mainnet RPC Providers

| Provider           | URL pattern                                               |
| ------------------ | --------------------------------------------------------- |
| Validation Cloud   | `https://mainnet.stellar.validationcloud.io/v1/<API_KEY>` |
| Ankr               | `https://rpc.ankr.com/stellar_soroban/<API_KEY>`          |
| Testnet (public)   | `https://soroban-testnet.stellar.org`                     |
| Futurenet (public) | `https://rpc-futurenet.stellar.org`                       |

> **Important:** Stellar RPC retains \~7 days of event history. For longer historical coverage, use [Galexie](https://developers.stellar.org/docs/data/indexers) + the [Token Transfer Processor](https://developers.stellar.org/docs/data/indexers/build-your-own/processors/token-transfer-processor).

***

## JSON:API Content Negotiation

All `GET` endpoints support the JSON:API specification via content negotiation. Include an `Accept: application/vnd.api+json` header to receive responses in JSON:API format.

### JSON:API Response Structure

Responses are transformed to the JSON:API document structure:

- **Collection endpoints** return an array in the `data` member with pagination metadata in `meta`
- **Single resource endpoints** return a single resource object in `data`
- **Error responses** return an array in the `errors` member with `title` and `detail` fields
- **Dates** are serialized as ISO 8601 strings
- **BigInt values** are converted to strings

### Example: Transfers in JSON:API Format

```bash
# Request with JSON:API Accept header
curl -H "Accept: application/vnd.api+json" http://localhost:3000/transfers/address/GABC123...

# Response
{
  "data": [
    {
      "id": "evt-001",
      "type": "transfer",
      "attributes": {
        "contractId": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
        "eventType": "transfer",
        "fromAddress": "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWWHF",
        "toAddress": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        "amount": "10000000",
        "ledger": 1001,
        "ledgerClosedAt": "2025-01-01T00:00:00.000Z",
        "txHash": "aaaa1111",
        "displayAmount": "1.0000000"
      }
    }
  ],
  "meta": {
    "total": 1,
    "limit": 50,
    "offset": 0
  }
}
```

### Example: Summary in JSON:API Format

```bash
curl -H "Accept: application/vnd.api+json" http://localhost:3000/summary/GABC123...

{
  "data": [
    {
      "id": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      "type": "token-summary",
      "attributes": {
        "contractId": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
        "totalReceived": "110000000",
        "totalSent": "170000000",
        "netFlow": "-60000000",
        "txCount": 3
      }
    }
  ],
  "meta": {
    "address": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    "window": { "fromDate": null, "toDate": null }
  }
}
```

### Supported Endpoints

| Endpoint | Resource Type |
|----------|---------------|
| `GET /transfers/address/:address` | `transfer` |
| `GET /transfers/incoming/:address` | `transfer` |
| `GET /transfers/outgoing/:address` | `transfer` |
| `GET /transfers/tx/:txHash` | `transfer` |
| `GET /summary/:address` | `token-summary` |
| `GET /accounts/:address/summary` | `account-summary` |
| `GET /accounts/:address/transfers` | `transfer` |
| `GET /assets/popular` | `popular-asset` |
| `GET /nfts/transfers` | `nft-transfer` |
| `GET /nfts/owners/:contract/:token_id` | `nft-owner` |
| `GET /status` | `status` |
| `GET /healthz` | `health` |
| `GET /readyz` | `readiness` |

***

## Event Types Indexed

| Type       | `fromAddress` | `toAddress` | Context                         |
| ---------- | ------------- | ----------- | ------------------------------- |
| `transfer` | ✅ sender      | ✅ recipient | Standard SEP-41 token transfer  |
| `mint`     | null          | ✅ recipient | New tokens minted to an address |
| `burn`     | ✅ holder      | null        | Tokens burned from an address   |
| `clawback` | ✅ holder      | null        | Tokens clawed back by admin     |

***

## Why Horizon Doesn't Cover This

From the [CAP-67 discussion](https://github.com/stellar/stellar-protocol/discussions/1553), SDF's stated position:

> *"We've made that mistake before with Horizon, by solving all indexing problems at the Horizon layer which encouraged folks to build on Horizon rather than innovate on new and or better data sources."*

Wraith is the third-party solution that SDF's architecture intentionally encourages.

***

***

## Command-Line Interface (CLI)

Wraith includes a lightweight, powerful command-line interface shipped as `@veil/wraith-cli`. It allows developers to query transfer histories, get aggregate token summaries, and stream live Stellar Soroban events directly in their terminal without writing boilerplate.

You can run it instantly without installation using `npx`:

```bash
npx @veil/wraith-cli --help
```

### Configuration
By default, the CLI connects to the public Wraith instance (`https://api.wraith.veil.co`). You can point it to a self-hosted instance or a local development server by setting the `WRAITH_URL` environment variable:

```bash
export WRAITH_URL="http://localhost:3000"
```

### Commands & Examples

#### 1. Query transfers
Retrieve transfer histories (transfers, mints, burns, clawbacks) for any Stellar address:

```bash
# Get all transfers for a specific account (pretty ASCII table by default)
npx @veil/wraith-cli transfers --account GABCDEFGHIJKLMNOPQRSTUVWXYZ

# Filter transfers to a specific token contract
npx @veil/wraith-cli transfers --account GABCDEFGHIJKLMNOPQRSTUVWXYZ --contract CB64D3G7SM2RTH6ISYIG4P2IYYD6J2OFR6B

# Retrieve only incoming transfers with custom pagination and limit
npx @veil/wraith-cli transfers --account GABCDEFGHIJKLMNOPQRSTUVWXYZ --direction incoming --limit 10 --offset 0

# Emit parseable JSON for scripts or piping
npx @veil/wraith-cli transfers --account GABCDEFGHIJKLMNOPQRSTUVWXYZ --json
```

#### 2. Account summaries
Get a grouped summary of token balances, incoming/outgoing flows, and transaction counts:

```bash
# View aggregate token statistics for an address
npx @veil/wraith-cli summary GABCDEFGHIJKLMNOPQRSTUVWXYZ

# Narrow down the summary to a specific timeframe
npx @veil/wraith-cli summary GABCDEFGHIJKLMNOPQRSTUVWXYZ --from-date 2025-01-01T00:00:00Z --to-date 2025-01-31T23:59:59Z

# Get raw JSON output
npx @veil/wraith-cli summary GABCDEFGHIJKLMNOPQRSTUVWXYZ --json
```

#### 3. Live watch (Streaming)
Establish a real-time WebSocket connection to stream new transfers as soon as they are indexed by the server:

```bash
# Stream all incoming/outgoing transfers for a specific address in real time
npx @veil/wraith-cli watch GABCDEFGHIJKLMNOPQRSTUVWXYZ

# Stream live events filtered by a specific token contract
npx @veil/wraith-cli watch GABCDEFGHIJKLMNOPQRSTUVWXYZ --contract CB64D3G7SM2RTH6ISYIG4P2IYYD6J2OFR6B

# Output live streams as a sequence of raw JSON lines (perfect for logging/scripting)
npx @veil/wraith-cli watch GABCDEFGHIJKLMNOPQRSTUVWXYZ --json
```

#### 4. Webhook Management
Manage real-time webhook subscriptions:

```bash
# List registered webhooks
npx @veil/wraith-cli webhooks list

# Register a new webhook url subscribing to specific events
npx @veil/wraith-cli webhooks create https://your-app.com/webhook --events transfer,mint

# Delete a webhook registration
npx @veil/wraith-cli webhooks delete <webhook-id>
```

***

## References

- [Stellar RPC](https://developers.stellar.org/network/soroban-rpc/methods/getEvents) [`getEvents`](https://developers.stellar.org/network/soroban-rpc/methods/getEvents)
- [CAP-67 Unified Token Events](https://github.com/stellar/stellar-protocol/discussions/1553)
- [SEP-41 Token Interface](https://stellar.org/protocol/sep-41)
- [Token Transfer Processor](https://developers.stellar.org/docs/data/indexers/build-your-own/processors/token-transfer-processor)
- [Galexie — Ledger Data Lake](https://developers.stellar.org/docs/data/indexers)
