# Wraith wave batch — parallel ingest, the money path, and query cost (DRAFT)

**Repo:** `Miracle656/wraith`. **IDs:** W094–W098. **Points:** Easy 100 · Intermediate 150 · Advanced 200.

## Shared with every issue

Wraith is a Soroban incoming-transfer indexer — it fills the gap Horizon leaves for SAC/SEP-41 token events by recipient address. Node/TypeScript, Prisma, REST + GraphQL + WebSocket, deployed on Render.

- **Unit tests are jest** (`src/**/__tests__`, `tests/*.test.ts`). **Integration tests are vitest** (`tests/integration/`, Docker). Do not mix runners in one file.
- Every PR needs a test that fails before the change and passes after, unless the issue says otherwise.
- **Validate every hard-coded `C…`/`G…`** with `StrKey.isValidContract` / `isValidEd25519PublicKey`. A recent PR here used a 55-character string in a fixture, which made the whole test file throw at import and run zero tests — while the PR reported it passing. A length check is not validation.
- Do not widen a Prometheus label to something unbounded. Addresses and contract ids must never become label values.
- Nothing may log or return a raw database error, a connection string, or a provider URL.
- Do not reformat a file you are changing. A diff that is mostly whitespace hides the part that matters.

---

### W094 · Parallel ingest silently stops indexing NFTs and account summaries

**Labels:** help wanted, Stellar Wave, area:indexer, difficulty:advanced

### Background
`src/indexer.ts:491` switches the whole ingest path based on one env var:

```ts
if (INGEST_WORKERS > 1 && loop.sacContractIds.length > 1) {
  const { totalInserted, highestLedger } = await pollParallel(…)
} else {
  currentLedger = await pollOnce(loop, currentLedger, target);
}
```

`pollOnce` parses NFT events and warms their metadata (`src/indexer.ts:379,392`) and maintains account summaries. `src/indexer/parallel.ts` imports only `fetchEventsSafe`, `parseEvents`, `upsertTransfers`, `setLastIndexedLedger` and `emitTransfer` — **no NFT parsing, no metadata, no account summaries**.

So raising `INGEST_WORKERS` for throughput quietly turns off whole categories of indexing. Nothing errors. The data simply stops arriving, and the only way to notice is to miss it downstream.

### What to build
- Bring the two paths back to one. Extract what `pollOnce` does per batch of records and have both call it, so a future addition cannot land in one path only.
- If some work genuinely cannot be sharded, make that explicit and refuse to start in parallel mode rather than silently degrading.
- A test that proves both paths produce the same rows for the same events — that is the real deliverable here, more than the fix.

### Acceptance criteria
- [ ] The same ledger range ingested through each path produces identical `TokenTransfer`, `NftTransfer` and `AccountSummary` rows
- [ ] Adding a new per-record step to one path and not the other fails that test
- [ ] `INGEST_WORKERS > 1` no longer changes what is indexed, only how fast
- [ ] The PR states which work is genuinely parallel-unsafe, if any

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### W095 · `/offramp/orders/:orderId` hands anyone the order

**Labels:** help wanted, Stellar Wave, area:api, difficulty:advanced

### Background
`src/api/offramp.ts:230` serves an order by id with no authorization. Anyone holding or guessing an order id reads the bank payout amount, the deposit address and the rate. This is the only money-moving router in the repo and it is the one surface with no auth story.

This needs a decision before it needs code, so treat the first half of this issue as design: orders are created by a wallet, so the natural answer is that the same wallet must prove itself to read one back — but the shape of that proof is a maintainer call, not a contributor guess.

### What to build
- Propose the auth model in the PR description first: a bearer credential issued at creation, a signature over the order id, or the existing API-key scheme extended to orders. Say what you chose and why.
- Make order ids unguessable regardless of which model wins — if an id is a secret, it must look like one.
- Rate-limit lookups so an unguessable id cannot be brute-forced quietly.
- No response may name the payment provider or echo an upstream error verbatim.

### Acceptance criteria
- [ ] An unauthenticated request for a valid order id is refused
- [ ] The legitimate creator can still read their own order
- [ ] Order ids carry enough entropy to survive enumeration, and a test asserts the format
- [ ] Repeated failed lookups are rate-limited
- [ ] Tests cover authorised, unauthorised and not-found, and the three are distinguishable to the caller only where they should be

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### W096 · NFT metadata is fetched one round trip at a time

**Labels:** help wanted, Stellar Wave, area:indexer, difficulty:intermediate

### Background
`src/indexer.ts:386-400` awaits `getNftMetadata` once per unique `(contract, tokenId)` inside a sequential `for` loop. A batch carrying a hundred new tokens makes a hundred serial round trips before the poll cycle can finish, and the loop's own budget does not account for it.

### What to build
- Batch or bound the concurrency — a small worker pool, or a single multi-key lookup where the source allows it.
- Cap total time spent on metadata per cycle so ingest never stalls behind it; metadata is enrichment, transfers are the product.
- Failures must stay per-token: one unreachable metadata URL should not cost the batch.

### Acceptance criteria
- [ ] A batch of N new tokens no longer costs N serial round trips — show the before and after
- [ ] A slow or failing metadata source cannot stall the ingest loop past a bounded budget
- [ ] One token's failure does not affect the others
- [ ] Tests cover a slow source, a failing source, and a mixed batch

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W097 · Every paged query pays for a full COUNT

**Labels:** help wanted, Stellar Wave, area:api, difficulty:intermediate

### Background
`src/db.ts:429-440` runs a full `COUNT` alongside every `findMany`. On a small table that is invisible; on the table this service exists to grow, the count becomes the dominant cost of every list request, and it is usually rendered as a number nobody reads.

### What to build
- Stop counting by default. Offer `hasMore` from an n+1 fetch, which answers the only question pagination actually needs.
- Where a total is genuinely wanted, make it opt-in per request and say in the API docs that it costs more.
- Check the indexes support the paged query on its own, without the count masking a missing one.

### Acceptance criteria
- [ ] The default list path issues no `COUNT`
- [ ] Pagination still knows whether another page exists, and a test covers the boundary
- [ ] An explicit opt-in still returns an exact total
- [ ] The PR reports query timings before and after on a seeded table of realistic size

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W098 · Tidy start-up and shut-down

**Labels:** help wanted, Stellar Wave, area:ci, difficulty:easy

### Background
Three small things in `src/index.ts`, each cheap and each capable of costing an afternoon:

- `main()` has no `.catch`, so a failure during start-up surfaces as an unhandled rejection rather than a clear exit.
- The `SKIP_INDEXER` check appears twice, and the second branch is unreachable.
- `shutdown()` never calls `server.close()`, so Render's SIGTERM drops in-flight requests instead of draining them.

### What to build
- Catch and exit non-zero with a legible message.
- Remove the dead branch.
- Close the server and wait for in-flight requests, with a timeout so a stuck request cannot block the shutdown forever.

### Acceptance criteria
- [ ] A start-up failure exits non-zero with a message naming the cause
- [ ] Only one `SKIP_INDEXER` check remains, and it is reachable
- [ ] SIGTERM drains in-flight requests, bounded by a timeout
- [ ] A test covers the drain and the timeout

> **Drips Wave** · Complexity: **Easy** · **100 points**
