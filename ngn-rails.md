# Naira rails

Three rails move money between naira and a Veil wallet, all through Linq:

| Rail | Direction | Route prefix | Order storage |
| --- | --- | --- | --- |
| **Offramp** | USDC/XLM out → NGN to a bank account | `/offramp` | Persisted (`OfframpOrder`) |
| **Onramp** | NGN in from a bank transfer → XLM/USDC to a wallet | `/ngn/onramp` | `NgnOrder` — [for the webhook, not for reads](#the-order-record-and-what-it-deliberately-is-not) |
| **Bills** | Wallet crypto → airtime, data, electricity, cable TV, betting | `/ngn/bills` | `NgnOrder` — same table, and the reason it exists |

The offramp is documented for clients in [offramp-orders.md](./offramp-orders.md); this
file is the whole surface, including the parts a client never sees.

## Why any of this is server-side

The Linq API key is the ability to spend — it creates orders that move real naira —
and anything shipped in an APK is extractable. The app never holds it. Every call
below is made by wraith with `X-API-Key`, never by a client, and never with a
consumer bearer token.

## The rules that apply to all three

### Mainnet only, and it is not a configuration preference

**Linq has no sandbox. Every call moves real money.** A Stellar `G…` address is
valid on both networks, so an order placed from a testnet session would take real
naira out of someone's bank and deliver real crypto to an address their testnet
wallet will never display. They would have paid and seen nothing.

`assertOnrampNetwork` refuses that outright. On `/ngn` it is applied as
router-level middleware, so it runs before any handler — a new route added to that
router is gated by default rather than by the author remembering.

```
GET /ngn/onramp/rate          (x-network: testnet)
→ 400  "…only available on mainnet"
```

Nothing reaches Linq. `networkMiddleware` also refuses a network the deployment
has not enabled, so `NETWORKS` must list `mainnet` for any of this to answer at
all.

### An unconfigured deployment says so

Without `LINQ_API_KEY`, `/ngn` returns **`503`**, not `500`:

```json
{ "error": "Naira rails are not configured on this deployment" }
```

That is what a client gating a CTA needs to hear, and it is true of any build
without the secret.

### Addresses are classic `G…`, never the smart-wallet contract

Linq pays by classic operation, and **a classic payment cannot name a contract as
its destination**. `rejectContractAddress` refuses a `C…` wherever Linq would be
asked to pay to it — the onramp's `walletAddress` and the bills `refundAddress` —
and also refuses anything that is not a well-formed `G…`.

Getting this wrong on a refund is worse than on a delivery: it fails at the moment
the user has already paid and been told their money is coming back. The receive
screen made this exact mistake once.

### Errors

Linq's own message names the real problem — an unverified customer, an unsupported
coin — far better than anything we would invent, so it is passed through.

| Linq status | We return |
| --- | --- |
| 4xx | the same status, with Linq's message |
| 5xx | `502` — the caller did nothing wrong |
| timeout | `504` |
| unreachable | `502` |

Every money-moving response carries `Cache-Control: no-store`.

### Timeouts

15s per request, **35s total budget per logical operation including retries**. A
server answering a person has to finish before their client gives up and tells
them it failed.

---

## Onramp — naira in, crypto out

This closes the cold-start problem no amount of wallet code can: a brand-new
Stellar account needs 1 XLM of base reserve plus 0.5 XLM per trustline before it
can hold a single USDC, and until now the only ways to get that first XLM were to
already own crypto or for us to fund it.

### 1. Provision the customer — once per person, not per order

```
POST /ngn/customers
{ customerRef, firstName, lastName, email, phone }
→ 200 { customerRef, verified, created }
```

Safe to call again: Linq returns the existing customer with `created: false`, so a
client retrying after a dropped response cannot create two customers for one
person.

### 2. Verify by NIN — once per person, ever

> **Confirmed with Linq, 2026-10-03.** Their NIN check is **NIN only** — no
> liveness and no face-match against the NIMC photo. They do **not** expose the
> sender's bank account name on an onramp order. But a NIN that has already
> verified one customer **cannot verify a second**: uniqueness is enforced.
>
> Three consequences, and the third is the one that bites:
>
> 1. **A stolen NIN still verifies.** NIN slips circulate widely in Nigeria, so
>    the check proves possession of a number, not identity. The blast radius is
>    bounded by uniqueness — one stolen NIN buys one account, not a farm — but
>    that one account's KYC record names an innocent person.
> 2. **The obvious free mitigation is unavailable.** Matching the sender's bank
>    account name to the verified name would force an attacker to also hold a
>    bank account in the victim's name, and Nigerian accounts are BVN-bound.
>    Linq does not expose the payer, so this cannot be built on their data. The
>    `f3` design screen renders `From · GTBank ··4821`, which this does not
>    support.
> 3. **Uniqueness turns a changed `customerRef` into a lockout.** A reference
>    that drifts is not a new name for the same person — it is a stranger whose
>    NIN is already spent. The mobile client therefore persists
>    `customerRef` (`getCustomerRef` in `lib/onramp.ts`) rather than deriving it
>    per read. A user who creates a genuinely new wallet, or reinstalls without
>    a backup, still lands on "NIN already used" with no way out.
>
> **The open question that matters most:** can an existing customer be resolved
> or re-bound for a NIN that is already verified? Without it, a reinstall is a
> permanent loss of the naira rails for that person. Ask before public launch.
>
> Liveness, if wanted, is now a Veil-side build (Smile ID, Dojah, Prembly and
> QoreID all do NIN-with-selfie). Weigh it carefully: biometric data is
> *sensitive* personal data under the NDPA, so it pulls in a DPIA and raises
> the stakes on NDPC registration — and it would not replace Linq's check,
> which stays the one of record. If built, the capture must go device →
> provider directly so no image ever touches wraith, and it must run *before*
> Linq's KYC so a failure never spends one of their rate-limited attempts.

```
POST /ngn/customers/kyc
{ customerRef, nin }
→ 200 { customerRef, verified, status }
```

**The NIN rule.** The NIN is read off the request and handed straight to Linq. It
is **never stored, never logged, never returned, and never placed in any type that
is persisted**. There is deliberately no `nin` field on `LinqCustomer` or
`CustomerKycResult`, so there is nothing to accidentally write to a database or an
error report. A test asserts the NIN does not appear in the response body.

This is not tidiness. A NIN is Nigerian personal data under the NDPA, and the
cheapest way to hold it correctly is not to hold it. **Any future change that adds
a NIN to a stored shape changes what this service legally is.**

An 11-digit shape check runs here so an obvious typo is answered without spending
a verification attempt, which Linq rate-limits. `submitCustomerKyc` is
deliberately **not** retried — a retried identity submission is a second
verification attempt against that limit.

### 3. Lock a rate

```
GET /ngn/onramp/rate
→ 200 { rate: 1356.15 }
```

**Never cached.** The offramp caches its rate for a few seconds because that one
is explicitly indicative. This one is not — it is the number locked into the order
the user is about to create, and XLM floats. A stale rate here prices someone's
order wrong.

Linq returns a **bare number** here, not an object like `/b2b/rate` does, so it is
parsed defensively and anything `≤ 0` is refused rather than passed on as a price.

### 4. Create the order

```
POST /ngn/onramp/orders
{ customerRef, amountStableCoin, walletAddress, rate, coin: "xlm" | "usdc" }
→ 200 { orderId, customerRef,
        accountNumber, bankName, accountName,
        amountNgn, amountStableCoin, fee,
        expiresAt, status }
```

The response carries the Nigerian bank account to transfer to. The user leaves the
app for their banking app; Linq delivers the crypto on confirmation.

**`expiresAt` is load-bearing for the UI.** The order is dead after it and the
customer must start again — so a screen that shows bank details without a
countdown will send someone to their banking app to transfer into an account that
has stopped accepting the payment.

**Coin mapping is exhaustive and asymmetric** — this is Linq's shape, not ours:

```ts
coin === "xlm"  ? { xlm: true }
coin === "usdc" ? { stellar: true }
                : unsupportedCoin(coin)   // never falls through
```

### 5. Read status

```
GET /ngn/onramp/orders/:orderId?customerRef=…
```

**Both identifiers are required.** See below.

---

## Bills — crypto out of the wallet, airtime in

This is the better of the two flows and the reason it shipped first: the onramp
makes the user leave the app to make a bank transfer, whereas a bill's deposit is
*crypto*, from a wallet we already hold the signer for. The whole thing happens in
one place.

```
POST /ngn/bills
{ customerRef, billCategory, provider, customerId,
  amountNgn, amountStableCoin, rate, coin, refundAddress }
→ 200 { id, customerRef, wallet, status }
```

`wallet` is the Stellar address the user sends the crypto to. Nothing is vended
until the deposit arrives — this call only reserves the order and locks the rate.

Categories: `airtime`, `data`, `electricity`, `cabletv`, `betting`. Airtime ships
first because it needs only a phone number and an amount; every other category
carries extra fields (a data plan, a meter type) worth their own validation.

### The two traps in this API

**1. `xlm` is omitted, never `false`.** Linq's docs are explicit: for USDC you drop
`xlm` entirely rather than setting it to `false`. Bills use a bare top-level
`xlm: true`, *not* the `coin: { … }` object the onramp uses.

```ts
export function buildCoinFields(coin: BillCoin): { xlm?: true } {
  return coin === "xlm" ? { xlm: true } : {};
}
```

It returns a spreadable object so a caller cannot accidentally write `xlm: false`,
which is not how this API is told "use USDC". A test asserts the key is *absent*,
not merely falsy.

**2. `refundAddress` is required and is not decorative.** It is where the deposit
goes if the biller rejects the top-up *after* the user has already paid — the
biller failing does not un-spend their XLM. It is validated before the request,
because a missing refund address is otherwise only discovered at the moment the
user's money is already gone.

### Manual deposit

Linq settles at whatever amount actually arrives, converted at the locked rate —
"this is a manual deposit by design". So the amount we send must be the amount we
quoted. **An underpayment is not a failed order, it is a smaller bill than the
user asked for.**

---

## The order record, and what it deliberately is not

The offramp persists its orders because it mints its own `publicId` and a bearer
token, so a client can read an order back without the provider's id ever leaving
the server. `/ngn` has a table too — `NgnOrder` — but it exists for a different
reason and grants no new read access.

**It exists because a bill's outcome is off-chain.** When Linq delivers XLM or
USDC for an onramp, the indexer sees the payment arrive at the wallet's classic
account and the existing address subscription already pushes it; the onramp
never needed a row to be observable. A biller vending airtime — or refusing to,
after the user has already paid — is invisible to the chain. Without a row,
`order.failed` arrives for an order we cannot identify, and the only thing that
ever learns about the failure is a client that happens to poll.

**Reads are unchanged.** Linq's status endpoints require **both** `customerRef`
and `orderId`, and return the same 404 for another customer's order as for one
that does not exist. `orderId` is an unguessable UUID, so knowing someone's
wallet address — which is semi-public — buys nothing on its own.
`findNgnOrder` enforces the same thing locally: it takes both, matches the
`customerRef` rather than merely accepting it, and returns `null` for a row
belonging to someone else, which is indistinguishable from one that is absent.

Two things are therefore deliberately missing, and both should stay missing:

> **There is no index on `customerRef`**, so nothing makes it cheap to list a
> customer's orders — and **no route may list orders by `customerRef` alone**.
> That would turn a public identifier into a way to read someone's bank details
> and amounts, and it is the one change that silently removes the protection.

> **`customerId` is not stored.** The phone number for airtime, the meter number
> for electricity — it is passed straight through to Linq at creation and kept
> nowhere, for the same reason the NIN never is.

Lookups are rate-limited with `skipSuccessfulRequests`, so a wallet polling its
own open order never spends the budget while someone trying ids they do not own
exhausts it quickly: 20 failures per minute.

### Falling back when Linq is down

If Linq answers **5xx or times out**, a status read is served from the record
instead of failing, marked `stale: true` with a reason. A **4xx is passed
through unchanged** — that is Linq telling us something true about the request
(an unverified customer, an order that is not yours), and papering over it with
a last-known row would turn "this order is not yours" into a status page.

Recording happens *after* the response is sent and never throws. The user is
holding bank details or a deposit address they need; our bookkeeping must not
stand between them and that. If the write fails, it is logged loudly and the
rail degrades to exactly the behaviour it had before the table existed.

## Webhooks

`POST /webhooks/linq` verifies Linq's signature over the **raw** body.

It **must** be mounted before `express.json()`. Linq signs the raw bytes, so any
middleware that parses and re-serialises first destroys the ability to verify —
the bytes change even when the value does not. wraith applies `express.json()`
globally, which is exactly the trap Linq's own docs warn about, so this router
brings its own `express.raw()` and is mounted ahead of it.

Events: `order.processing`, `order.completed`, `order.failed`.

One endpoint carries all three rails, and the body does not say which rail an
event belongs to — only an `orderId`. So reconciliation is "find the order that
id belongs to": the offramp table first, then `NgnOrder`. An id in neither is
logged and ignored; nothing here creates a row, because an event for an order we
never placed is not ours to act on.

Reconciliation is idempotent by construction — it writes settled figures to a row
keyed on the order id, so a redelivery writes the same values rather than
double-counting. The 200 is sent *before* reconciling, because Linq times out at
10 seconds and marks the delivery failed, and a database write on a throttled
instance can outlast that.

---

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `LINQ_API_KEY` | yes | Business key. Its absence is what makes `/ngn` answer `503`. |
| `LINQ_BASE_URL` | no | Overrides the default Linq host. |
| `LINQ_WEBHOOK_SECRET` | for webhooks | HMAC secret for `x-linq-signature`. |
| `NETWORKS` | yes | Must include `mainnet` or none of this answers. |
| `SOROBAN_RPC_URL_MAINNET` | for indexing | **Not needed by these rails** — they are plain HTTP to Linq. But listing `mainnet` in `NETWORKS` turns on the mainnet *indexer*, which does need it. Without it the indexer skips mainnet and says so; the API, and everything here, keeps serving. |
| `OFFRAMP_LOOKUP_MAX_FAILURES` | no (`10`) | Offramp failed lookups per window. |
| `OFFRAMP_LOOKUP_WINDOW_MS` | no (`900000`) | Offramp lookup window. |

## Schema convergence

`src/index.ts` runs `prisma db push` at boot — **without** `--accept-data-loss`.
With that flag, any change Prisma read as destructive applied silently on the next
deploy, taking the column and everything in it. This database holds offramp
orders: records of real naira paid to real bank accounts. A deploy that refuses to
start is a problem someone fixes in minutes; a column of payment records that
vanished during a routine deploy is not recoverable. Additive changes still apply
on their own.

## What is not built

| Gap | Consequence |
| --- | --- |
| Nothing pushes a bill result to the client | The webhook now records a completed or failed bill, but no subscription carries it to the wallet, so the client still has to ask. The onramp does not share this gap — its delivery is an on-chain payment the indexer already pushes. |
| Bills ship airtime only in the UI | The other four categories are accepted by the API but carry unvalidated extra fields (a data plan, a meter type). |
| Mobile screens | Designed, not built. |

## Tests

```
src/__tests__/linq/bills.test.ts     the coin trap, refundAddress, auth header
src/__tests__/routes/ngn.test.ts     mainnet gate, C-address refusal, NIN absence
```

The route tests need `NETWORKS=testnet,mainnet` in the environment, because
`networkMiddleware` refuses a network the deployment has not enabled — the same
way a real deployment does.
