# Wraith wave batch — correctness, public surface, wiring (DRAFT)

**Repo:** `Miracle656/wraith`. **IDs:** W078–W093. **Points:** Easy 100 · Intermediate 150 · Advanced 200.

**Before publishing:** ensure the `Stellar Wave`, `help wanted`, `difficulty:*` and `points:*` labels exist, plus `area:indexer`, `area:api`, `area:ci`.

## Shared with every issue

### How this repo is laid out

Wraith is a Soroban incoming-transfer indexer: it fills the gap Horizon leaves for SAC/SEP-41 token events by recipient address. Roughly 14k lines under `src/`, REST + GraphQL + WebSocket, Postgres via Prisma, deployed on Render.

- **Unit tests are jest** (`src/**/__tests__`, `tests/*.test.ts`), with a coverage gate.
- **Integration tests are vitest** (`tests/integration/`, `vitest.integration.config.ts`, Docker).
- Don't mix the two runners in one file.

### Known state of `main` before you start

`tsc --noEmit` and the unit suite are green. **The `Integration tests` CI job is red**, and so is `Load test` — both predate this batch. Open PRs #177 and #178 address them. If the integration job is red when you open a PR, that is not your fault; say so in the PR and carry on.

Four modules are shipped, closed as done, and imported by nothing: `src/indexer/checkpoint.ts`, `src/ingest/reorg.ts`, `src/middleware/opa.ts`, and `src/api/candles.ts` + `src/workers/ohlc-refresh.ts`. So the live indexer today has no reorg handling and no atomic checkpointing, despite both features being closed. Two issues below start unpicking that — don't assume a closed issue means a wired feature.

### Ground rules

- Every PR needs a test that fails before the change and passes after, unless the issue says otherwise.
- Don't widen a Prometheus label to something unbounded — addresses and contract ids must never become label values.
- Nothing may log or return a raw database error, a connection string, or a provider URL.
- Don't reformat a file you're changing. A diff that is 90% whitespace hides the 10% that matters.

---

### W078 · Stop one malformed event wedging the indexer forever

**Labels:** help wanted, Stellar Wave, area:indexer, difficulty:easy

### Background
`parseEvents` (`src/decoder.ts:146-163`) calls `parseEvent` in a bare loop with no try/catch. But `parseEvent` **throws** — there are six `throw new Error("Malformed …")` sites at `src/decoder.ts:98, 103, 109, 113, 120, 124`, and `src/__tests__/decoder.test.ts:75-96` asserts that it throws.

Its own docstring at line 143 claims it is "silently skipping unrecognised or malformed ones". It isn't. The throw escapes `pollOnce` (`src/indexer.ts:318`) into the loop catch at `src/indexer.ts:519-523`, which sleeps and retries **the identical ledger range forever**. One bad event on chain stops indexing permanently, and the only symptom is a repeating log line.

### Acceptance criteria
- [ ] `parseEvents` wraps each `parseEvent` in try/catch, counts failures, and returns the good records
- [ ] A batch of `[good, malformed, good]` returns 2 records instead of throwing — fails on `main`
- [ ] The skipped-decode count is logged distinctly from the existing "non-token events" count
- [ ] `parseEvent` keeps throwing; only the batch wrapper changes
- [ ] An `events_skipped_total{reason}` counter in `src/metrics.ts`

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### W079 · Advance the cursor to the ledger actually covered, not the chain tip

**Labels:** help wanted, Stellar Wave, area:indexer, difficulty:advanced

### Background
`fetchEvents` (`src/rpc.ts:105-145`) sends one `getEvents` request with a `limit` and returns `resp.latestLedger` — the **network tip**, not the highest ledger the returned events actually cover. It never reads `resp.cursor`, so a truncated page is simply lost. `fetchEventsSafe`'s happy path (`src/rpc.ts:217-219`) passes that tip straight through as `highestLedger`, ignoring its `endLedger` argument, and `pollOnce` commits it as the cursor (`src/indexer.ts:402`).

Two consequences: a range producing more than `EVENTS_BATCH_SIZE` events drops the remainder and never refetches it, and the cursor jumps past `target = tip - TIP_LAG` (`src/indexer.ts:483`), defeating the propagation buffer that exists to avoid reading un-settled ledgers.

### Acceptance criteria
- [ ] `fetchEvents` returns the paging cursor and the maximum `event.ledger` seen, alongside `latestLedger`
- [ ] A full page causes the caller to page with the cursor until the range is drained or a page budget is hit
- [ ] `highestLedger` is `min(last ledger fully covered, endLedger)` — never the raw tip
- [ ] A test with a mocked RPC returning exactly `limit` events proves the second page is lost on `main` and ingested after
- [ ] A test proves the cursor never exceeds the `endLedger` passed in

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### W080 · Use each token's real decimals for `displayAmount`

**Labels:** help wanted, Stellar Wave, area:api, difficulty:intermediate

### Background
`toDisplayAmount` (`src/api.ts:88-95`) divides every amount by a hardcoded `STROOPS = 10_000_000n` (`src/api.ts:81`). Wraith already fetches and caches per-token `decimals` (`src/rpc.ts:280-290`, `src/tokenCache.ts:10`), and that cache's own comment says serving the wrong `decimals` is worse than the wrong symbol.

So every 6-decimal token — USDC included, the asset the offramp actually moves — is displayed **10× too small**, across REST (`src/db.ts:447`), CSV/Parquet export (`src/routes/exports.ts:94, 147`) and the WebSocket stream (`src/ws.ts:41`).

### Acceptance criteria
- [ ] `toDisplayAmount(amount, decimals)`, defaulting to today's behaviour when decimals are unknown
- [ ] Read-path callers pass the cached decimals for the row's `contractId`
- [ ] A 6-decimal token's `displayAmount` equals `amount / 1e6` — fails before, passes after
- [ ] 7-decimal output is byte-identical to today; existing snapshots unchanged
- [ ] A token with no cached metadata still renders and does not error

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W081 · Put the network in the Redis cache key

**Labels:** help wanted, Stellar Wave, area:api, difficulty:easy

### Background
`defaultKeyFn` (`src/cache/redis.ts:131-137`) builds the cache key from method, path and sorted query string. But the network selector is also accepted as the `X-Network` header (`src/middleware/network.ts:31, 44-46`), which is invisible to that function.

`/assets/popular` and `/search` are both cached (`src/api.ts:205, 211`). With `CACHE_ENABLED=true` and both networks enabled, a mainnet request and a testnet request collide on one key, and whichever lands first is served to both chains for the whole TTL.

### Acceptance criteria
- [ ] The key includes the resolved `req.network`
- [ ] Two requests differing only by `X-Network` produce different keys — fails on `main`
- [ ] `?network=mainnet` and `X-Network: mainnet` produce the *same* key, so they share an entry
- [ ] The PR notes that existing keys change shape and simply expire

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### W082 · Stop treating any error containing "unknown" as an XDR failure

**Labels:** help wanted, Stellar Wave, area:indexer, difficulty:intermediate

### Background
`fetchEventsSafe` decides whether to skip a ledger by substring-matching the error message: `if (msg.includes("XDR") || msg.includes("unknown"))` at `src/rpc.ts:209`, and again at `:222`.

"unknown" matches far too much — `getaddrinfo ENOTFOUND … unknown host`, a bare `unknown error`, provider 5xx bodies. When it matches, the ledger is **silently skipped and the cursor advances past it** (`src/rpc.ts:211`). A transient network blip is therefore indistinguishable from a genuinely unindexable ledger, and the data is gone with nothing but a `console.warn`.

### Acceptance criteria
- [ ] Classification moves to a named predicate covering the real XDR cases and *not* bare "unknown"
- [ ] A transient `Error("unknown error")` propagates and is retried instead of skipping the ledger — fails before, passes after
- [ ] A genuine XDR error still bisects and skips; existing `fetchEventsSafe` tests stay green
- [ ] Every skipped ledger increments a metric, so skips are visible rather than only logged

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W083 · Stop returning raw internal errors to unauthenticated callers

**Labels:** help wanted, Stellar Wave, area:api, difficulty:easy

### Background
The global error handler at `src/api.ts:1005-1008` responds with `res.status(500).json({ error: err.message })`. Prisma and pg errors carry table names, column names and constraint names, and sometimes connection details; `src/rpc.ts:277` throws with `JSON.stringify(resp)` embedded. Any unhandled path hands that to whoever asked.

### Acceptance criteria
- [ ] 500 responses return a fixed message plus a generated correlation id
- [ ] The full error, with that id, is still logged server-side
- [ ] Deliberate 4xx responses keep their messages
- [ ] A test forcing `new Error('relation "token_transfer" does not exist')` asserts the body does not contain that text — fails on `main`

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### W084 · Bound and validate the CSV and Parquet exports

**Labels:** help wanted, Stellar Wave, area:api, difficulty:intermediate

### Background
`GET /transfers.csv` and `/transfers.parquet` (`src/routes/exports.ts:178-179`, mounted at the root in `src/api.ts:208`) require no filter and cap no rows: `streamTransfers` (`src/routes/exports.ts:52-72`) pages the whole `TokenTransfer` table 500 rows at a time until it runs out. The Parquet path materialises the entire result into a temp file (`:116, :137`) before sending a byte.

Parameters are unvalidated too — `parseInt(String(fromLedger), 10)` at `:39-40` yields `NaN`, and `new Date(String(fromDate))` at `:44-46` yields `Invalid Date`. Both reach Prisma and surface as a 500.

### Acceptance criteria
- [ ] Parameters validated with a zod schema; bad input returns 400, not 500
- [ ] An env-configurable `maxRows` cap is applied and truncation is signalled to the caller
- [ ] A request with no narrowing filter is either rejected or capped — pick one and document it
- [ ] Tests: `?fromLedger=abc` returns 400, and an export over a seeded table stops at the cap

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W085 · Document the endpoints missing from the OpenAPI spec

**Labels:** help wanted, Stellar Wave, area:api, difficulty:easy

### Background
`openapi.json` and its copy `docs/openapi.json` list 20 paths. Live but undocumented: `GET /tokens` (`src/api.ts:282`), `GET /transfers.csv` and `/transfers.parquet` (`src/routes/exports.ts:178-179`), and all five `/offramp/*` routes (`src/api/offramp.ts:83, 101, 114, 139, 230`). The README's endpoint list misses them too.

The spec is generated from zod by `npm run docs:openapi` (`src/openapi/build.ts`), so this is schema work, not hand-editing JSON.

### Acceptance criteria
- [ ] Zod schemas added for `/tokens` and the two export routes, registered in `src/openapi/build.ts`
- [ ] `/offramp/*` documented, or explicitly marked internal with a one-line rationale in the spec
- [ ] `npm run docs:openapi` regenerates deterministically and both `openapi.json` files match
- [ ] A test asserts every route registered on the app appears in the generated spec — fails on `main`

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### W086 · Make the offramp order endpoint idempotent, and test it

**Labels:** help wanted, Stellar Wave, area:api, difficulty:intermediate

### Background
`src/api/offramp.ts` has **no test file**, and it is the only money-moving router in the repo.

`POST /offramp/orders` does a `findUnique` on the idempotency key (`:171`), creates the order at the provider (`:191`), then inserts the row (`:208`). Two concurrent taps both miss the `findUnique`; the provider dedupes, but the second `create` violates `@@unique([network, idempotencyKey])` (`prisma/schema.prisma:420`) and falls into `sendLinqError` as a bare 500 — even though the order exists and is fine.

Amounts are unvalidated: `Number(amountNGN)` at `:192` turns `"abc"` into `NaN`, and accepts negatives and `Infinity`.

### Acceptance criteria
- [ ] The pre-check and insert become an idempotent upsert, or `P2002` is caught and the existing row returned as `replayed: true`
- [ ] Amounts validated with zod — positive, finite, within a configured bound; bad input returns 400 before any provider call
- [ ] Route tests with a mocked provider client: happy path, replay, concurrent duplicate returns 200 not 500, `amountNGN: "abc"` returns 400
- [ ] No user-facing message names the payment provider

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W087 · Label RPC errors by network, and export the chain tip

**Labels:** help wanted, Stellar Wave, area:indexer, difficulty:easy

### Background
`rpcErrorsTotal` (`src/metrics.ts:58-63`) has only an `outcome` label, and `recordRpcError` is called from `src/rpc.ts:167, 170` without a network. With two loops running you cannot tell which chain's provider is failing — which is the entire point of the metric.

Separately, `last_indexed_ledger` is exported (`src/metrics.ts:71-76`) but the **chain tip is not**, so Prometheus cannot compute indexer lag. `/status` computes it (`src/api.ts:445`), but that is a JSON endpoint, not a scrape target.

### Acceptance criteria
- [ ] `rpc_errors_total` gains a `network` label, threaded from the `withRetry` callers
- [ ] A `chain_tip_ledger{network}` gauge is set on each successful tip read
- [ ] The README `/metrics` sample block is updated
- [ ] Tests assert the new labels and series appear in `renderMetrics()` — fails before

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### W088 · Instrument the HTTP surface in Prometheus

**Labels:** help wanted, Stellar Wave, area:api, difficulty:easy

### Background
`src/metrics.ts` exports indexer counters and a DB-query histogram, but nothing about HTTP: no request count, no status breakdown, no latency. `/metrics` is served at `src/api.ts:268` and deliberately exempted from rate limiting (`src/api.ts:72`) — the scrape endpoint exists, the API just never reports on itself. A route that starts returning 500s is invisible on the same dashboard that shows ingest health.

### Acceptance criteria
- [ ] `http_requests_total{method,route,status}` and `http_request_duration_seconds{method,route}` in `src/metrics.ts`
- [ ] One middleware in `createApp()` records both on response finish
- [ ] The `route` label uses the Express route pattern (`/transfers/incoming/:address`), never the raw path — addresses must not become label values
- [ ] `/metrics` is excluded from its own counters
- [ ] A supertest hit increments the counter with the expected labels — fails before

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### W089 · Mount the candles router and start its refresh worker

**Labels:** help wanted, Stellar Wave, area:api, difficulty:easy

### Background
Issue #100 shipped the SQL aggregates, the router (`src/api/candles.ts:71`, `:101`), the worker (`src/workers/ohlc-refresh.ts:58`) and the zod response schemas. None of it is reachable: `createCandlesRouter` has **zero importers**, `src/api.ts` never mounts it, and `src/index.ts` never starts the worker — compare `startWebhookWorker()` at `src/index.ts:47` and `startPartitionRetentionJob()` at `:50`. The feature is closed and completely inert.

### Acceptance criteria
- [ ] `createCandlesRouter()` mounted at `/candles` in `createApp()`
- [ ] `startOhlcRefreshWorker()` started in `src/index.ts`, behind an interval env var, and skipped under `SKIP_INDEXER=true`
- [ ] `/candles/{bucket}/{contractId}` appears in the generated OpenAPI spec
- [ ] A supertest route test that returns 404 on `main` and passes after

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### W090 · Replace the placeholder checkpoint test with real coverage

**Labels:** help wanted, Stellar Wave, area:indexer, difficulty:easy

### Background
`src/__tests__/checkpoint.test.ts` asserts nothing about behaviour. Every case constructs a TypeScript interface literal and checks the fields it just assigned — `it("should define BatchMetadata interface correctly")`. It exercises no runtime code.

Meanwhile `src/indexer/checkpoint.ts` holds the real logic (`isBatchProcessed`, the transactional commit at `:60-140`) and has **zero importers**, so the "exactly-once ingest" feature from closed issue #101 is untested dead code that still counts toward the coverage gate.

### Acceptance criteria
- [ ] Behavioural tests against a mocked `prisma`: a fresh batch inserts and advances the checkpoint; a replayed `batchId` is a no-op; a failed insert rolls back so the checkpoint does not advance
- [ ] The vacuous interface-shape cases are removed
- [ ] `commitBatch` and `isBatchProcessed` are actually executed — visible in the coverage report, where they are currently at zero
- [ ] The PR states in one line that the module is still not wired into `startIndexer()`

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### W091 · Apply committed migrations on boot instead of `db push --accept-data-loss`

**Labels:** help wanted, Stellar Wave, area:ci, difficulty:intermediate

### Background
`src/index.ts:18` runs `execSync("npx prisma db push --accept-data-loss")` on **every** startup, while `prisma/migrations/` holds seven committed migrations that are never applied. `db push` diffs the schema and drops whatever does not match; `--accept-data-loss` makes that non-interactive. Commit `1acb9dd` ("let db push add the network primary key to populated tables") is the scar tissue from exactly this.

`tests/integration/migrations.test.ts` already tests migration idempotency, so the migrations are verified and simply unused.

### Acceptance criteria
- [ ] Startup runs `prisma migrate deploy`; `db push` survives only behind an explicit dev/test flag
- [ ] A migration failure is fatal with a clear message — a half-migrated database serving traffic is worse than a crash
- [ ] `docs/` documents the drift-recovery path for a database that was previously `db push`ed
- [ ] A fresh database reaches the current schema via `migrate deploy` alone
- [ ] `--accept-data-loss` appears on no production path

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W092 · Add `npm run db:seed` with deterministic fixtures

**Labels:** help wanted, Stellar Wave, area:ci, difficulty:easy

### Background
There is no seed anywhere: `prisma/` holds only `migrations/` and `schema.prisma`, `scripts/` holds one backfill script, and `package.json` has no seed entry. A contributor who follows the README Quick Start gets an empty database and must wait for live testnet events on a watched contract before any endpoint returns a row.

Fixtures already exist but are locked inside the vitest-only integration suite (`tests/integration/fixtures.ts`) and `src/__tests__/fixtures/events.json`.

### Acceptance criteria
- [ ] `npm run db:seed` inserts deterministic `TokenTransfer` / `NftTransfer` / `AccountSummary` rows across at least two addresses and two contracts
- [ ] Rows are tagged `network`, and the seed accepts a `--network` flag
- [ ] Running it twice does not duplicate
- [ ] The README Quick Start gains a "seed and query" step whose sample output is real
- [ ] Ideally the integration harness reuses the same fixture module rather than keeping a second copy

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### W093 · Bring `docker-compose.yml` back in line with the env contract

**Labels:** help wanted, Stellar Wave, area:ci, difficulty:easy

### Background
The dev compose file is stale against `.env.example`. It passes only the legacy names `STELLAR_RPC_URL` and `CONTRACT_IDS`, and omits `STELLAR_NETWORK`, `NETWORKS`, `SOROBAN_RPC_URL`, `SAC_CONTRACT_IDS`, `DIRECT_DATABASE_URL`, `RETENTION_DAYS` and the entire Redis block — so `docker compose up` cannot produce a dual-network stack and cannot exercise the cache layer at all. It also still carries the obsolete `version: "3.9"` key.

This is distinct from issue #63, which is about the integration-test compose file; that one exists and works.

### Acceptance criteria
- [ ] Env keys match `.env.example`; legacy names removed, or kept only as documented aliases
- [ ] An optional `redis` service so `CACHE_ENABLED=true` works out of the box
- [ ] `version:` removed
- [ ] `docker compose config` is warning-free and `docker compose up` reaches a healthy `/readyz` on testnet with no extra env
- [ ] README "Start Postgres" / "Start Wraith" steps updated to match

> **Drips Wave** · Complexity: **Easy** · **100 points**
