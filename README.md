# Wraith 👻

[![CI](https://github.com/Miracle656/wraith/actions/workflows/ci.yml/badge.svg)](https://github.com/Miracle656/wraith/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Stellar](https://img.shields.io/badge/Stellar-Soroban-black)](https://stellar.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

> **Soroban incoming token transfer indexer** — fills the gap that Horizon leaves open.

Horizon indexes Classic Stellar operations (payments, path payments) but does **not** index Soroban `transfer` events by recipient address. Wraith polls Stellar RPC `getEvents`, parses CAP-67/SEP-41 token events (`transfer`, `mint`, `burn`, `clawback`), stores them in Postgres, and exposes a REST API to query by address.

***

## Architecture

```
Stellar RPC getEvents (polling loop)
    ↓
Parser (ScVal decoding, CAP-67 normalisation)
    ↓
Postgres (Prisma ORM — indexed by toAddress, fromAddress, contractId, ledger)
    ↓
Express REST API (GET /transfers/incoming/:address, etc.)
```

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

A complete, production-grade OpenAPI 3.0 specification is available for all Wraith REST endpoints.

- **[openapi.yaml](./openapi.yaml)**

You can use this file to explore the API, generate client SDKs, or import it into tools like:

- [Swagger UI](https://swagger.io/tools/swagger-ui/) or [Swagger Editor](https://editor.swagger.io/)
- [Postman](https://www.postman.com/)
- [Redoc](https://redocly.com/redoc/)

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

### Mainnet RPC Providers

| Provider           | URL pattern                                               |
| ------------------ | --------------------------------------------------------- |
| Validation Cloud   | `https://mainnet.stellar.validationcloud.io/v1/<API_KEY>` |
| Ankr               | `https://rpc.ankr.com/stellar_soroban/<API_KEY>`          |
| Testnet (public)   | `https://soroban-testnet.stellar.org`                     |
| Futurenet (public) | `https://rpc-futurenet.stellar.org`                       |

> **Important:** Stellar RPC retains \~7 days of event history. For longer historical coverage, use [Galexie](https://developers.stellar.org/docs/data/indexers) + the [Token Transfer Processor](https://developers.stellar.org/docs/data/indexers/build-your-own/processors/token-transfer-processor).

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

## References

- [Stellar RPC](https://developers.stellar.org/network/soroban-rpc/methods/getEvents) [`getEvents`](https://developers.stellar.org/network/soroban-rpc/methods/getEvents)
- [CAP-67 Unified Token Events](https://github.com/stellar/stellar-protocol/discussions/1553)
- [SEP-41 Token Interface](https://stellar.org/protocol/sep-41)
- [Token Transfer Processor](https://developers.stellar.org/docs/data/indexers/build-your-own/processors/token-transfer-processor)
- [Galexie — Ledger Data Lake](https://developers.stellar.org/docs/data/indexers)

