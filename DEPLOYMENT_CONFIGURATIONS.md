# Deployment Configurations

Wraith's behavior is almost entirely driven by environment variables: which networks index, whether the naira rails answer, whether the candles route and OHLC refresh worker are mounted, which RPC endpoints are queried, and how long records are retained.

`.env.example` documents variables one at a time. This document describes **three real-world deployment shapes end-to-end**: what each is designed for, the exact environment variables it sets, what it does, and what it explicitly does not do.

---

## Secrets & Sensitivity Classification

Variables used across Wraith deployments fall into three security classes:

| Classification | Rule | Examples |
|---|---|---|
| **Secret** | **Never commit to source control or embed in public configs.** Store exclusively in hosting provider secrets managers (e.g. Render Environment Secrets, Vault, Doppler). | `DATABASE_URL`, `DIRECT_DATABASE_URL`, `DATABASE_REPLICAS`, `LINQ_API_KEY`, `LINQ_WEBHOOK_SECRET`, `SOROBAN_RPC_URL_MAINNET` (or any URL with an embedded API key/token) |
| **Sensitive Operational** | Specific to deployment infrastructure; keep private to operational configs. | Internal endpoints (`OPA_URL`, `REDIS_URL`), non-public hostnames |
| **Public Configuration** | Safe in version control and default templates. Non-sensitive switches and public endpoints. | `STELLAR_NETWORK`, `NETWORKS`, public testnet RPC URLs, contract IDs (`SAC_CONTRACT_IDS`), port numbers, rate limits, timeouts |

> [!CAUTION]
> Never commit real database connection strings or RPC provider URLs with embedded API keys to git.

---

## 1. The Live Production Deployment (Veil Hybrid Rails + Testnet Ingest)

### What it is for
This is Wraith's current live deployment configuration. It powers the production Veil wallet back-end.

In this setup:
1. It services production **naira rails** (`/ngn` onramp and bill payments, plus `/offramp`), which move real money through Linq and are strictly gated to `mainnet` at the router.
2. It runs the **testnet indexer loop** to ingest Soroban token events on testnet for QA, sandbox testing, and developer wallet flows.
3. It intentionally runs **no mainnet Soroban RPC endpoint**. Mainnet indexing is not running on this instance.

### Environment Specification

```env
# ─── Database (Required) ────────────────────────────────────────────────────
# Secret: Credentials for the managed PostgreSQL instance (Neon / Supabase).
DATABASE_URL=postgresql://[user]:[password]@[host]/[dbname]?sslmode=require
DIRECT_DATABASE_URL=postgresql://[user]:[password]@[host]/[dbname]?sslmode=require

# ─── Network Selection ──────────────────────────────────────────────────────
# Default fallback network for unspecified requests
STELLAR_NETWORK=testnet

# Both networks are declared so the HTTP API accepts requests for either testnet or mainnet.
# mainnet is REQUIRED here for /ngn and /offramp to respond.
NETWORKS=testnet,mainnet

# ─── Soroban RPC ────────────────────────────────────────────────────────────
# Testnet uses the free public RPC endpoint (fallback default if left empty).
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org

# No mainnet RPC endpoint is set.
# SOROBAN_RPC_URL_MAINNET is intentionally omitted.

# ─── SAC Contracts ──────────────────────────────────────────────────────────
# Testnet native XLM SAC contract ID
SAC_CONTRACT_IDS_TESTNET=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC

# ─── Retention ──────────────────────────────────────────────────────────────
RETENTION_DAYS=30

# ─── Naira Rails & Payments (Secret) ────────────────────────────────────────
# Secret: Linq API credentials for production fiat onramp, offramp, and bill payments.
LINQ_API_KEY=[secret-linq-api-key]
LINQ_WEBHOOK_SECRET=[secret-linq-webhook-signing-secret]

# ─── Disabled Features ──────────────────────────────────────────────────────
# Candles worker disabled (defaults to 0)
OHLC_REFRESH_INTERVAL_MS=0
```

### What it DOES
* **Processes real-money naira rails on mainnet:** Routes `/ngn/onramp`, `/ngn/bills`, and `/offramp` accept mainnet requests (`x-network: mainnet`), creating orders and quoting live rates against the Linq provider.
* **Indexes Stellar Testnet:** Continuously polls the public Soroban testnet RPC, ingesting and parsing SEP-41/CAP-67 token events (transfers, mints, burns) and updating testnet account balances and cursors.
* **Serves Testnet reads & WebSockets:** Serves REST endpoints (`/accounts/:id/transfers`, `/search`, `/assets/popular`, GraphQL) and real-time subscriptions for testnet.
* **Boots cleanly without mainnet RPC:** `planNetworks()` detects that `SOROBAN_RPC_URL_MAINNET` is missing, logs that mainnet indexing is skipped, and proceeds without crashing or blocking testnet indexing or the HTTP API.

### What it DOES NOT do
* **Does NOT index mainnet:** Because `SOROBAN_RPC_URL_MAINNET` is not provided, no mainnet indexer loop runs. Mainnet blockchain events are not ingested into the database.
* **Does NOT serve fresh mainnet indexed ledger data:** Any transfer or token queries on mainnet return only previously existing database records, flagged with `X-Data-Stale: true` and `stale: true`.
* **Does NOT mount `/candles` routes:** Because `OHLC_REFRESH_INTERVAL_MS` is `0` (and `NETWORKS` contains multiple networks), the `/candles` router is not mounted, and the OHLC refresh background worker is not run.
* **Does NOT allow naira operations on testnet:** Linq has no sandbox. If a caller sends `x-network: testnet` to `/ngn` or `/offramp`, the request is rejected with `400 Bad Request` ("...only available on mainnet").

---

## 2. Dedicated Single-Network Mainnet Production Indexer

### What it is for
A dedicated high-availability instance whose sole responsibility is indexing Stellar Mainnet token activity and serving production ledger reads, transfers, account balances, and GraphQL queries for mainnet applications.

### Environment Specification

```env
# ─── Database (Required) ────────────────────────────────────────────────────
# Secret: Production managed PostgreSQL database (e.g., Neon or AWS RDS).
DATABASE_URL=postgresql://[user]:[password]@[host]/wraith_mainnet?sslmode=require
DIRECT_DATABASE_URL=postgresql://[user]:[password]@[host]/wraith_mainnet?sslmode=require

# ─── Network Selection ──────────────────────────────────────────────────────
STELLAR_NETWORK=mainnet
NETWORKS=mainnet

# ─── Soroban RPC (Secret) ───────────────────────────────────────────────────
# Secret: Private paid mainnet RPC endpoint (Validation Cloud, Ankr, or private node).
SOROBAN_RPC_URL=https://mainnet.stellar.validationcloud.io/v1/[secret-api-key]
# Or explicit network suffix:
# SOROBAN_RPC_URL_MAINNET=https://mainnet.stellar.validationcloud.io/v1/[secret-api-key]

# ─── Monitored Contracts ───────────────────────────────────────────────────
# Explicit mainnet SAC contract IDs (XLM native SAC + USDC Centre):
SAC_CONTRACT_IDS=CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA,CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75

# ─── Indexer Performance & Retention ───────────────────────────────────────
POLL_INTERVAL_MS=6000
EVENTS_BATCH_SIZE=10000
RETENTION_DAYS=90

# ─── Response Cache (Optional) ─────────────────────────────────────────────
CACHE_ENABLED=true
REDIS_URL=redis://:[password]@[cache-host]:6379

# ─── Unused Rails ──────────────────────────────────────────────────────────
# Naira credentials intentionally unset on a pure indexer node
# LINQ_API_KEY=
# LINQ_WEBHOOK_SECRET=
OHLC_REFRESH_INTERVAL_MS=0
```

### What it DOES
* **Indexes Stellar Mainnet continuously:** Watches specified mainnet contracts (native XLM SAC, USDC) using the authenticated Soroban RPC provider.
* **Maintains mainnet state:** Decodes and stores transfers, mints, burns, clawbacks, and account summaries.
* **Serves mainnet REST, GraphQL, and WebSocket subscriptions:** Returns up-to-date token activity with `stale: false`.
* **Caches hot read endpoints:** Uses Redis (when enabled) to cache `/assets/popular` and `/search`.

### What it DOES NOT do
* **Does NOT process naira rails:** Because `LINQ_API_KEY` is omitted, any attempt to access `/ngn` or `/offramp` returns `503 Service Unavailable` ("Naira rails are not configured on this deployment").
* **Does NOT touch or index testnet:** `NETWORKS=mainnet` ensures testnet requests are rejected by `networkMiddleware`, and no testnet RPC or database connection is used.
* **Does NOT mount `/candles`:** Disabled when `OHLC_REFRESH_INTERVAL_MS` is unset or `0`.

---

## 3. Local Development & Integration Testing Deployment

### What it is for
For developers running Wraith locally via Docker or `npm run dev` to test API routes, testnet indexing, or offramp features against fake test providers.

### Environment Specification

```env
# ─── Database ───────────────────────────────────────────────────────────────
# Local Docker Postgres instance (default credentials; non-secret local environment)
DATABASE_URL="postgresql://wraith:wraith@localhost:5432/wraith"
DIRECT_DATABASE_URL="postgresql://wraith:wraith@localhost:5432/wraith"

# ─── Network Selection ──────────────────────────────────────────────────────
STELLAR_NETWORK="testnet"
NETWORKS="testnet"

# ─── Soroban RPC ────────────────────────────────────────────────────────────
# Default public testnet endpoint (free, no auth token required)
SOROBAN_RPC_URL="https://soroban-testnet.stellar.org"

# ─── Watched Contracts ──────────────────────────────────────────────────────
# Default native XLM testnet SAC
SAC_CONTRACT_IDS="CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"

# ─── Indexer & API Controls ────────────────────────────────────────────────
# Set SKIP_INDEXER=true when running integration tests against a pre-seeded database
SKIP_INDEXER=false
POLL_INTERVAL_MS=6000
RETENTION_DAYS=7
PORT=3000

# ─── Naira Rails (Omitted) ──────────────────────────────────────────────────
# Do not set live Linq credentials in development.
LINQ_API_KEY=
LINQ_WEBHOOK_SECRET=
```

### What it DOES
* **Runs locally without cloud dependencies:** Connects to local PostgreSQL on `localhost:5432`.
* **Indexes public testnet:** Ingests live testnet activity for development and debugging.
* **Serves developer endpoints:** Inspect `/status`, `/healthz`, `/metrics`, and OpenAPI documentation locally.
* **Supports test harness execution:** When `SKIP_INDEXER=true`, allows integration test suites to run HTTP requests against seeded test fixtures without polling live RPC.

### What it DOES NOT do
* **Does NOT touch mainnet or spend real money:** Mainnet is disabled in `NETWORKS`. Naira rails (`/ngn`, `/offramp`) return `503` because no Linq keys are configured.
* **Does NOT require paid RPC keys:** Uses Stellar's public testnet RPC.
* **Does NOT persist across database resets:** Designed for ephemeral local development and short data retention (`RETENTION_DAYS=7`).

---

## Configuration Comparison Matrix

| Variable / Capability | Live Production (Veil Hybrid) | Dedicated Mainnet Indexer | Local Dev / Testing | Security Sensitivity |
|---|---|---|---|---|
| `STELLAR_NETWORK` | `testnet` | `mainnet` | `testnet` | Public |
| `NETWORKS` | `testnet,mainnet` | `mainnet` | `testnet` | Public |
| `DATABASE_URL` | External managed DB | External managed DB | `localhost:5432` | **Secret** (in prod) |
| `SOROBAN_RPC_URL` | Public testnet RPC | Paid mainnet RPC URL | Public testnet RPC | **Secret** (mainnet) / Public (testnet) |
| `SOROBAN_RPC_URL_MAINNET` | *Unset* | Paid mainnet RPC URL | *Unset* | **Secret** |
| `LINQ_API_KEY` | Real Linq API Key | *Unset* | *Unset* | **Secret** |
| `LINQ_WEBHOOK_SECRET` | Real Webhook Secret | *Unset* | *Unset* | **Secret** |
| `OHLC_REFRESH_INTERVAL_MS` | `0` (disabled) | `0` (disabled) | `0` (disabled) | Public |
| **Indexes Testnet** | **Yes** | No | **Yes** | — |
| **Indexes Mainnet** | **No** (skipped at boot) | **Yes** | No | — |
| **Processes Naira Rails** | **Yes** (mainnet only) | No (`503`) | No (`503`) | — |
| **Mounts `/candles` API** | No | No | No | — |
