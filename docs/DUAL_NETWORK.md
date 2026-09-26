# Dual-Network (mainnet + testnet) — Foundation

Goal: run Wraith on **mainnet and testnet at the same time**, keeping testnet as
the safe demo/QA surface while mainnet handles real value.

## Architecture options

1. **Two deployments (recommended, no refactor).** Same image, one env set +
   one database per network. Sidesteps the in-process work entirely.
2. **In-process dual-network.** One process indexes both networks. Requires the
   issues below (network-aware storage, per-network RPC, per-network loops, a
   network selector on the API).

Either way the storage must be network-segregated. As of #159 it is: every
model carries a `network` column, `eventId` is unique per `(network, eventId)`
rather than globally, and `IndexerState`/`BackfillCursor` hold one row per
network instead of the old singleton `id = 1`.

Every `db.ts` function takes an optional trailing `network`, defaulting to
`STELLAR_NETWORK` via `src/network.ts`. Single-network deployments therefore
behave exactly as before; #161 and #163 pass it explicitly.

## Env matrix

| Var | testnet | mainnet |
|-----|---------|---------|
| `NETWORKS` | `testnet` | `testnet,mainnet` to index both in one process |
| `STELLAR_NETWORK` | `testnet` | `mainnet` |
| `SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` | external provider endpoint (**secret — host env only**) |
| `SAC_CONTRACT_IDS` | testnet SAC `CDMLFMKM…` | mainnet XLM SAC `CDLZFC3SY…` |
| `DATABASE_URL` | testnet DB | **separate** mainnet DB |
| `HORIZON_URL` | optional testnet | optional `https://horizon.stellar.org` |

> Mainnet has **no free public Soroban RPC** — an external provider endpoint is
> required. Never commit the endpoint/key; it lives only in host secrets.

### In-process dual-network (#160, #161)

Set `NETWORKS=testnet,mainnet` to run one indexer loop per network in a single
process. Each loop owns its cursor, counters, watch list, RPC client and source
switcher, so neither can stall or repoint the other, and `/status` reports both
under `networks`.

Every setting that names a chain takes a per-network suffix, falling back to the
shared name: `SOROBAN_RPC_URL_MAINNET`, `HORIZON_URL_MAINNET`,
`SAC_CONTRACT_IDS_MAINNET`, `NFT_CONTRACT_IDS_MAINNET`, `START_LEDGER_MAINNET`
(and the `_TESTNET` equivalents).

> The **unsuffixed** `SOROBAN_RPC_URL` applies only to the network named by
> `STELLAR_NETWORK`. That is deliberate: honouring it for both would let a
> mainnet loop connect to a testnet endpoint and write testnet ledgers tagged
> `network='mainnet'`. Indexing mainnet requires `SOROBAN_RPC_URL_MAINNET`.

## Ordered work (next Wave)

Dependencies: **#159 → #161** and #160 before #161.

| # | Issue | Dep |
|---|-------|-----|
| ~~[#159](../../issues/159)~~ | ~~`network` column across all Prisma models~~ (done) | — |
| ~~[#160](../../issues/160)~~ | ~~Per-network `getRpc(network)` factory~~ (done) | — |
| ~~[#161](../../issues/161)~~ | ~~One indexer loop per network~~ (done) | #159, #160 |
| [#162](../../issues/162) | Per-network SAC/NFT watch-lists | — |
| [#163](../../issues/163) | `network` selector on REST/GraphQL/WS | #159–#161 |
| [#164](../../issues/164) | Serve stale cached data instead of 503 | — |
| ~~[#165](../../issues/165)~~ | ~~Nightly `pg_dump` backup + restore runbook~~ (done) | — |
| [#166](../../issues/166) | Mainnet deploy guide | the rest |

## Ops (Render + UptimeRobot + external Postgres)

- **Compute:** Render free web service kept awake by UptimeRobot pinging
  `/status` every 5 min. Note the **750 instance-hours/month** free cap — one
  service can stay always-on; two (mainnet + testnet) exceed it, so run mainnet
  always-on and testnet on-demand / a second account / a paid instance.
- **Database:** use Neon or another managed Postgres. **Do not** use Render's
  free Postgres — it is **deleted after 90 days**. One DB per network.
- **Durability fallback:** nightly `pg_dump` (#165, see
  [`docs/backup-restore.md`](backup-restore.md)) for fast restore; because
  Wraith is an indexer, the DB is also re-derivable by re-indexing from chain.
  Requires `DATABASE_URL_TESTNET` / `DATABASE_URL_MAINNET` backup secrets, one
  per network's database.
