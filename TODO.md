# Wraith — TODO

Track open improvements, bugs, and planned features. Update this file as issues are completed.

---

## API Improvements

- [ ] **Combined activity endpoint** `GET /transfers/address/:address`
  Return incoming + outgoing in a single call, sorted by ledger desc.
  Currently the wallet makes two separate requests and merges client-side.
  _GitHub issue: #1_

- [ ] **Add `displayAmount` field to API responses**
  All endpoints return `amount` as raw i128 stroops (e.g. `"10000000000"`).
  Add a `displayAmount` field that divides by 10^7 so consumers don't each implement their own formatting.
  Raw `amount` stays in the response for precision.
  _GitHub issue: #2_

- [ ] **Date-range filtering on transfer endpoints**
  Add `fromDate` / `toDate` query params (ISO 8601) to `/transfers/incoming/:address` and `/transfers/outgoing/:address`.
  Queries by `ledgerClosedAt`. Needed for agentic queries like "what came in this week?".
  _GitHub issue: #3_

- [ ] **`GET /summary/:address` — aggregate stats endpoint**
  Return: total received, total sent, net flow, per-token breakdown, optional date range.
  Enables single-query answers to "what's my XLM activity this month?" without fetching all records client-side.
  _GitHub issue: #4_

- [ ] **`eventType` filter on transfer endpoints**
  Add `eventType` query param (`transfer` | `mint` | `burn` | `clawback`) to all transfer endpoints.
  `burn` and `clawback` are stored in DB but currently unreachable without fetching everything.
  _GitHub issue: #5_

---

## Agentic Layer (Phase 1 — Human-in-the-loop)

- [ ] Integrate Wraith as data source for AI agent tools (`get_history`, `get_summary`)
- [ ] Wire `/summary/:address` into agent "what came in this week?" tool

## Agentic Layer (Phase 2 — Delegated autonomous agent)

- [ ] Soroban contract: new signer type with spend limit, contract whitelist, session expiry
- [ ] Agent executes within policy without per-tx passkey approval

---

## Housekeeping

- [ ] Mint events — confirm Friendbot and airdrop mints are surfaced in the wallet UI
- [ ] Multi-contract: document how to set `CONTRACT_IDS` env var on Render
