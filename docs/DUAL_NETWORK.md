# Dual-Network (mainnet + testnet) — Foundation

Goal: run Wraith on **mainnet and testnet at the same time**, keeping testnet as
the safe demo/QA surface while mainnet handles real value.

## Architecture options

1. **Two deployments (recommended, no refactor).** Same image, one env set +
   one database per network. Sidesteps the in-process work entirely.
2. **In-process dual-network.** One process indexes both networks. Requires the
   issues below (network-aware storage, per-network RPC, per-network loops, a
   network selector on the API).

Either way the storage must be network-segregated: today the schema has **no
`network` column**, so two networks in one DB collide (`eventId` is globally
unique; `IndexerState`/`BackfillCursor` are singleton rows).

## Env matrix

| Var | testnet | mainnet |
|-----|---------|---------|
| `STELLAR_NETWORK` | `testnet` | `mainnet` |
| `SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` | external provider endpoint (**secret — host env only**) |
| `SAC_CONTRACT_IDS` | testnet SAC `CDMLFMKM…` | mainnet XLM SAC `CDLZFC3SY…` |
| `DATABASE_URL` | testnet DB | **separate** mainnet DB |
| `HORIZON_URL` | optional testnet | optional `https://horizon.stellar.org` |

> Mainnet has **no free public Soroban RPC** — an external provider endpoint is
> required. Never commit the endpoint/key; it lives only in host secrets.

## Ordered work (next Wave)

Dependencies: **#159 → #161** and #160 before #161.

| # | Issue | Dep |
|---|-------|-----|
| [#159](../../issues/159) | `network` column across all Prisma models | — |
| [#160](../../issues/160) | Per-network `getRpc(network)` factory | — |
| [#161](../../issues/161) | One indexer loop per network | #159, #160 |
| [#162](../../issues/162) | Per-network SAC/NFT watch-lists | — |
| [#163](../../issues/163) | `network` selector on REST/GraphQL/WS | #159–#161 |
| [#164](../../issues/164) | Serve stale cached data instead of 503 | — |
| [#165](../../issues/165) | Nightly `pg_dump` backup + restore runbook | — |
| [#166](../../issues/166) | Mainnet deploy guide | the rest |

## Ops (Render + UptimeRobot + external Postgres)

- **Compute:** Render free web service kept awake by UptimeRobot pinging
  `/status` every 5 min. Note the **750 instance-hours/month** free cap — one
  service can stay always-on; two (mainnet + testnet) exceed it, so run mainnet
  always-on and testnet on-demand / a second account / a paid instance.
- **Database:** use Neon or another managed Postgres. **Do not** use Render's
  free Postgres — it is **deleted after 90 days**. One DB per network.
- **Durability fallback:** nightly `pg_dump` (#165) for fast restore; because
  Wraith is an indexer, the DB is also re-derivable by re-indexing from chain.
