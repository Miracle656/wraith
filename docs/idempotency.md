# Idempotency on the naira rails

What is safe to send twice, why, and how sure we are. Every claim here has a test
in one of these two files, and when the two disagree, the tests are the ones to trust:

```
src/__tests__/linq/idempotency.test.ts     the provider clients, against the fake
src/__tests__/routes/idempotency.test.ts   the HTTP routes, end to end, against the fake
src/__tests__/fakes/linqProvider.ts        the fake: what we believe Linq does
```

## Why this needs writing down

Every creating call to Linq is wrapped in `retryOnProviderFailure`, which repeats it
once on a 5xx or a dropped connection. **Neither of those means nothing happened.**
Linq can create the order and then lose the answer — a reset connection, a proxy
timeout — and our retry goes out not knowing. A retry is safe only if the thing it
repeats is idempotent, and that depends on the route.

Linq has no sandbox, so we cannot test against them. What we believe about their
behaviour lives in one place, the fake, with each belief marked `BELIEF:`. If
Linq's behaviour turns out to differ, correct the fake. The tests that relied on the
old belief then fail in CI instead of in production.

## The routes

| Route | Idempotent? | Keyed on | Who enforces it |
| --- | --- | --- | --- |
| `POST /offramp/orders` | **Yes** | `idempotencyKey` (+ `walletAddress`, amount) | Us, then Linq |
| `POST /ngn/customers` | **Yes**, for creation | `customerRef` | Linq only |
| `POST /webhooks/linq` | **Yes**, per event | `orderId` | Us |
| `POST /ngn/onramp/orders` | **No** | — | — |
| `POST /ngn/bills` | **No** | — | — |
| `POST /ngn/customers/kyc` | **No claim made** | — | Not retried; see W079 |

### `POST /offramp/orders`

**Our side.** The key is looked up in `OfframpOrder` before Linq is called. A match
with the same wallet and amount replays the stored order (`200`, `replayed: true`,
same `id`, new `accessToken`). A different wallet or amount gets `409`. The
replay never reaches Linq.

**Linq's side.** We send `idempotencyKey` on every create, and the retry inside
`createOfframpOrder` sends the identical body. **We believe** Linq returns the
original order for a key it has seen. Their docs accept the field but do not say
what it guarantees, so this is unconfirmed. Two cases rely on it, because our own
check cannot see an order we have not recorded:

1. **Linq's answer is lost on the way to us.** The internal retry repeats the create
   with the same key.
2. **Linq created the order, then our database write failed.** The client gets a
   `500` and retries. With no row to find, the retry goes back to Linq with the same
   key.

**Concurrent duplicates.** Two identical requests in flight together both miss the
lookup. Linq deduplicates, and the `@@unique([network, idempotencyKey])` index
refuses the second insert. **No duplicate is created**, but the losing caller gets
a `500` for an order that exists. Its retry then replays the order normally. Note
that a replay issues a new `accessToken` and the winner's token stops working; for
two submits from one client, that is the same person.

**Not covered.** A replay that changes only the bank details (`bankAccount`,
`bankCode`, `bankName`, `accountName`) still replays, because those fields are not
stored. See the comment in `src/api/offramp.ts`.

#### Scope and lifetime of the key

| | Scope | Lifetime |
| --- | --- | --- |
| **Ours** | One network. The same key on testnet and mainnet makes two separate orders (tested). It is bound to the wallet that first used it. | **Forever.** `OfframpOrder` rows are never deleted, so a key is spent for good. There is no expiry to wait out. |
| **Linq's** | **Unknown.** Presumably our business account, with no notion of network: Linq has one environment. The fake assumes this. Unlike `/ngn`, the offramp router is not gated to mainnet, so a key reused across networks is reachable. We would hold two rows (one per network), and Linq would return the first order to both. A random key per order makes this practically impossible (tested). | **Unknown.** The fake remembers keys forever, which is the most generous reading. If Linq forgets keys after some window, case 2 above becomes a duplicate order once that window has passed. |

So **clients must generate a fresh random key per order, and send the same key
again only when retrying that order**. Never derive a key from the order's contents.
Two genuine orders for the same amount would then collide and get a `409`.

### `POST /ngn/customers`

**We do no deduplication.** This works only because **Linq keys customers on
`customerRef`** and returns an existing one unchanged with `created: false`. Both
a client's retry and the internal retry after a dropped answer end with one
customer (tested).

It is weaker than "the same request twice is a no-op" in two ways:

- **The details are not updated.** A repeat with a corrected email or phone returns
  the existing customer and keeps the old details. Provisioning again is not how
  you fix a typo.
- **`created` describes the moment Linq answered, not this request.** After a
  dropped answer, the retry finds the customer that the first attempt made, and the
  caller is told `created: false` for someone who did not exist a second earlier.
  Do not use `created` to decide whether to show a welcome step.

`customerRef` has no expiry. A reference, once provisioned, is that person at Linq
for good, which is why a drifting reference becomes a NIN lockout (see
[ngn-rails.md](./ngn-rails.md)).

### `POST /webhooks/linq`

A redelivered event writes the same values again: one row, nothing counted twice
(tested for both the offramp and the onramp/bill tables). `recordNgnOrder` is
likewise an upsert on `(network, orderId)`.

**Not order-safe.** The last delivery wins. A late redelivery of `order.processing`
that arrives after `order.completed` sets the status back to processing until the
next status poll corrects it. This is not a double-count, but the row reads wrong
in the meantime.

### `POST /ngn/onramp/orders` and `POST /ngn/bills`: **not idempotent**

No key is sent and Linq documents none, yet both are retried on a 5xx or a dropped
connection. A retry after a lost answer **places a second order**, and the caller
is given the second. A client that resubmits gets a second order the same way. Both
are pinned by tests, so whoever adds a key has to update them.

**Why this does not move money twice.** Creating an order only reserves it. The
user is shown one order's bank account or deposit address, the one that answered,
and pays into that. The orphan receives no deposit and lapses at `expiresAt`. If
Linq sends a webhook for it, it arrives for an id we never recorded and is logged
and ignored.

**What would make it idempotent.** Find out from Linq whether `/b2b/onramp` and
`/b2b/bills/pay` accept an idempotency key. If they do, take one from the client
as the offramp does. If they do not, consider not retrying a dropped connection or
timeout on these two, since those are the ambiguous failures, and keep the retry
for a 5xx that Linq documents as "nothing was created".

### `POST /ngn/customers/kyc`

**No claim is made, and none should be until Linq answers.** It is not retried
today. W079 proposes retrying it on 5xx. Before that lands, someone needs to know
what Linq does with a second submission of a NIN that the first attempt already
verified against *the same* `customerRef`. It might be a success, or it might be
`nin_already_used`. If it is the latter, a retry after a dropped answer turns a
successful verification into a refusal the user cannot get past. The fake
implements no KYC endpoint, so this is deliberately not encoded as a belief.

## The 429 assumption

`call()` in `src/linq/client.ts` retries a `429` up to twice, order creation
included. That is safe only if a rate-limited request did no work. This is the
conventional meaning of 429, but Linq has not stated it. The fake refuses a 429
before doing anything, and one test relies on it.

## Changing any of this

- **Linq tells us something new:** change the fake first, then make the tests pass.
- **Adding a creating call:** decide which row of the table above it belongs to
  before wrapping it in `retryOnProviderFailure`, then add it to both test files.
