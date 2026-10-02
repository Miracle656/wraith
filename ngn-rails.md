# Naira rails

Three rails move money between naira and a Veil wallet, all through Linq:

| Rail | Direction | Route prefix | Order storage |
| --- | --- | --- | --- |
| **Offramp** | USDC/XLM out → NGN to a bank account | `/offramp` | Persisted (`OfframpOrder`) |
| **Onramp** | NGN in from a bank transfer → XLM/USDC to a wallet | `/ngn/onramp` | None — see [Why `/ngn` has no order table](#why-ngn-has-no-order-table) |
| **Bills** | Wallet crypto → airtime, data, electricity, cable TV, betting | `/ngn/bills` | None — same reason |

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

## Why `/ngn` has no order table

The offramp persists its orders because it mints its own `publicId` and a bearer
token, so a client can read an order back without the provider's id ever leaving
the server.

These two rails do not need that, and adding a table would be the more dangerous
choice. Linq's status endpoints require **both** `customerRef` and `orderId`, and
return the same 404 for another customer's order as for one that does not exist.
`orderId` is an unguessable UUID, so knowing someone's wallet address — which is
semi-public — buys nothing on its own. That is the same property the offramp's
`publicId` provides, already enforced upstream.

> **What must never be added here is a route that lists orders by `customerRef`
> alone.** That would turn a public identifier into a way to read someone's bank
> details and amounts, and it is the one change that silently removes the
> protection.

Lookups are rate-limited with `skipSuccessfulRequests`, so a wallet polling its
own open order never spends the budget while someone trying ids they do not own
exhausts it quickly: 20 failures per minute.

---

## Webhooks

`POST /webhooks/linq` verifies Linq's signature over the **raw** body.

It **must** be mounted before `express.json()`. Linq signs the raw bytes, so any
middleware that parses and re-serialises first destroys the ability to verify —
the bytes change even when the value does not. wraith applies `express.json()`
globally, which is exactly the trap Linq's own docs warn about, so this router
brings its own `express.raw()` and is mounted ahead of it.

Events: `order.processing`, `order.completed`, `order.failed`.

> ⚠️ **Today this reconciles the offramp only.** Onramp and bill orders have no
> webhook handling — their status is read on demand through Linq. See
> [What is not built](#what-is-not-built).

---

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `LINQ_API_KEY` | yes | Business key. Its absence is what makes `/ngn` answer `503`. |
| `LINQ_BASE_URL` | no | Overrides the default Linq host. |
| `LINQ_WEBHOOK_SECRET` | for webhooks | HMAC secret for `x-linq-signature`. |
| `NETWORKS` | yes | Must include `mainnet` or none of this answers. |
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
| No webhook handling for onramp or bill orders | Status is pull-only. A completed order is not known until something asks. |
| No onramp order persistence | Nothing to show a user who lost their `orderId`. Additive to add — the schema converges at boot — but it reintroduces the question above, so any such table must still require both identifiers. |
| Bills ship airtime only in the UI | The other four categories are accepted by the API but carry unvalidated extra fields. |
| Mobile screens | Designed, not built. |

## Tests

```
src/__tests__/linq/bills.test.ts     the coin trap, refundAddress, auth header
src/__tests__/routes/ngn.test.ts     mainnet gate, C-address refusal, NIN absence
```

The route tests need `NETWORKS=testnet,mainnet` in the environment, because
`networkMiddleware` refuses a network the deployment has not enabled — the same
way a real deployment does.
