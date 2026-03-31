# Wraith 👻

> **Soroban incoming token transfer indexer** — fills the gap that Horizon leaves open.

Horizon indexes Classic Stellar operations (payments, path payments) but does **not** index Soroban `transfer` events by recipient address. Wraith polls Stellar RPC `getEvents`, parses CAP-67/SEP-41 token events (`transfer`, `mint`, `burn`, `clawback`), stores them in Postgres, and exposes a REST API to query by address.

---

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

---

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

Edit `.env`:
```env
DATABASE_URL="postgresql://wraith:wraith@localhost:5432/wraith"
STELLAR_RPC_URL="https://soroban-testnet.stellar.org"

# Leave blank to start from the chain tip (recommended for first run)
START_LEDGER=

# Comma-separated contract IDs to watch, or leave empty for all contracts
CONTRACT_IDS=

PORT=3000
```

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

---

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

---

### `GET /transfers/incoming/:address`

All token transfers **received** by an address.

| Param | Type | Description |
|---|---|---|
| `contractId` | string | Filter to a specific token contract (`C...`) |
| `fromLedger` | int | Inclusive lower ledger bound |
| `toLedger` | int | Inclusive upper ledger bound |
| `limit` | int | Page size (max 200, default 50) |
| `offset` | int | Pagination offset |

```bash
# All incoming transfers for an address
curl "http://localhost:3000/transfers/incoming/GABC123..."

# Filter to a specific token, last 1000 ledgers
curl "http://localhost:3000/transfers/incoming/GABC123...?contractId=CTOKEN...&fromLedger=5840000&limit=20"
```

---

### `GET /transfers/outgoing/:address`

All token transfers **sent** by an address. Same query params as `/incoming`.

```bash
curl "http://localhost:3000/transfers/outgoing/GABC123..."
```

---

### `GET /transfers/tx/:txHash`

All token events emitted within a transaction.

```bash
curl "http://localhost:3000/transfers/tx/abcdef1234567890..."
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | — | Postgres connection string (required) |
| `STELLAR_RPC_URL` | — | Stellar RPC endpoint (required) |
| `START_LEDGER` | *(tip)* | Ledger to start indexing from. Leave blank to resume from DB state, or start near the tip. |
| `POLL_INTERVAL_MS` | `6000` | Polling interval (~1 ledger ≈ 6 s) |
| `CONTRACT_IDS` | *(all)* | Comma-separated token contract IDs to watch. Empty = watch all (heavy on mainnet) |
| `EVENTS_BATCH_SIZE` | `10000` | Max events per RPC call (RPC hard-cap is 10 000) |
| `PORT` | `3000` | REST API port |

---

## RPC Endpoints

| Network | URL |
|---|---|
| Mainnet | `https://mainnet.sorobanrpc.com` |
| Testnet | `https://soroban-testnet.stellar.org` |
| Futurenet | `https://rpc-futurenet.stellar.org` |

> **Important:** Stellar RPC retains ~7 days of event history. For longer historical coverage, use [Galexie](https://developers.stellar.org/docs/data/indexers) + the [Token Transfer Processor](https://developers.stellar.org/docs/data/indexers/build-your-own/processors/token-transfer-processor).

---

## Event Types Indexed

| Type | `fromAddress` | `toAddress` | Context |
|---|---|---|---|
| `transfer` | ✅ sender | ✅ recipient | Standard SEP-41 token transfer |
| `mint` | null | ✅ recipient | New tokens minted to an address |
| `burn` | ✅ holder | null | Tokens burned from an address |
| `clawback` | ✅ holder | null | Tokens clawed back by admin |

---

## Why Horizon Doesn't Cover This

From the [CAP-67 discussion](https://github.com/stellar/stellar-protocol/discussions/1553), SDF's stated position:

> *"We've made that mistake before with Horizon, by solving all indexing problems at the Horizon layer which encouraged folks to build on Horizon rather than innovate on new and or better data sources."*

Wraith is the third-party solution that SDF's architecture intentionally encourages.

---

## References

- [Stellar RPC `getEvents`](https://developers.stellar.org/network/soroban-rpc/methods/getEvents)
- [CAP-67 Unified Token Events](https://github.com/stellar/stellar-protocol/discussions/1553)
- [SEP-41 Token Interface](https://stellar.org/protocol/sep-41)
- [Token Transfer Processor](https://developers.stellar.org/docs/data/indexers/build-your-own/processors/token-transfer-processor)
- [Galexie — Ledger Data Lake](https://developers.stellar.org/docs/data/indexers)
