# Wave batch — NGN rails hardening (W078–W091)

Drafted 2026-10-14, after a day in which four users tried to verify a NIN and
none succeeded, and the service could not say why. Every issue below is a real
gap found while debugging that, not a hypothetical.

## Shared with every issue

**Repo:** `Miracle656/wraith` — the Veil backend. Node + Express + Prisma, deployed on Render.

**Run the tests before and after:** `npm test`. One suite, `src/__tests__/openapiCoverage.test.ts`, is red on `main` before you start — that is W082's job, not yours, unless you picked W082.

**The naira rails are mainnet-only and have no sandbox.** Every call to the provider moves real money or real personal data. Do not add a code path that reaches them from a test. The existing suites mock `global.fetch`; follow that.

**A NIN is personal data under Nigeria's NDPA.** It exists as a function argument, goes into one request body, and is unreachable afterwards. There is deliberately no `nin` field on any persisted type. Do not add one, do not log one, and do not put one in a test fixture that looks real.

---

### W078 · One provider client, not two that have quietly drifted apart

**Labels:** help wanted, Stellar Wave, area:backend, difficulty:advanced, epic:ngn-rails

### Background
`src/linq/client.ts` and `src/linq/onramp.ts` each define their own `call()` against the same provider, with the same auth, against the same base URL. They were written months apart and have drifted in every detail that matters:

| | `client.ts` | `onramp.ts` (before 2026-10-13) |
|---|---|---|
| error `code` parsed | yes | **no** |
| non-JSON error body | kept as the message | **discarded** |
| per-call timeout | 15s, overridable | 15s, fixed |

The cost was not theoretical. For a full day the KYC screen could only say "rejected the request", because the client serving it threw away both halves of the provider's answer while its sibling fifteen files away parsed them correctly. Three users were shown a guess instead of a reason.

### What to build
- One HTTP client for this provider, used by `client.ts`, `onramp.ts` and `bills.ts`.
- It owns: auth header, timeout and deadline handling, JSON and non-JSON error parsing, `code` extraction, retry/backoff policy, and the failure logging.
- Per-call differences stay as arguments, not as forks. A NIN check needing 30s is a parameter; it is not a reason for a second client.
- Behaviour must not change: the suites in `src/__tests__/linq/` pin the current error shapes and should pass untouched.

### Acceptance criteria
- [ ] Exactly one `call()` implementation reaches the provider
- [ ] `src/__tests__/linq/` passes with no changes to its assertions
- [ ] A test proves every route returns the provider's `code` when it sends one
- [ ] A test proves a short plain-text error body survives, and an HTML error page does not
- [ ] The PR says what behaviour differed between the two before merging, and which won

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### W079 · A NIN check that fails once fails for good

**Labels:** help wanted, Stellar Wave, area:backend, difficulty:advanced, epic:ngn-rails

### Background
`provisionCustomer` and `createOnrampOrder` both wrap their call in `retryOnProviderFailure`. `submitCustomerKyc` does not — it calls straight through:

```ts
export function submitCustomerKyc(customerRef: string, nin: string): Promise<CustomerKycResult> {
  return call<CustomerKycResult>("/b2b/customers/kyc", { ... })   // no retry
}
```

So a transient 5xx from the identity provider is terminal. That is the least forgiving place in the whole system to have no retry, because a NIN verifies **once, ever** against one customer reference: a user who meets a blip has no way to tell it from a refusal, and the screen behind it cannot tell either.

This is not hypothetical. On 2026-10-14 the endpoint returned a 5xx in ~2.2 seconds, consistently, and every user hit it bare.

### What to build
- Retry `submitCustomerKyc` on 5xx and on a connection failure, with backoff, inside a total budget that stays under the clients' own 40s ceiling.
- **Never retry a 4xx.** `nin_already_used` and `invalid_nin_format` are answers, not failures, and retrying them wastes an attempt against a rate-limited provider.
- The deadline must bound the whole operation including retries, as `retryOnProviderFailure` already does elsewhere.

### Acceptance criteria
- [ ] A 500 followed by a 200 verifies, with one retry and no duplicate side effect
- [ ] A 409 `nin_already_used` is returned immediately, with no retry
- [ ] The total elapsed time is bounded and tested, not just the per-attempt timeout
- [ ] The retry does not resend the NIN to a route that has already answered

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### W080 · The offramp rate is naira per dollar and nothing says so

**Labels:** help wanted, Stellar Wave, area:backend, difficulty:advanced, epic:ngn-rails

### Background
`GET /offramp/rate` takes no coin and returns whatever the provider's `/b2b/rate` gives. Live, today, that is:

```json
{"coin":"USDSUI","currency":"NGN","rate":1356.75,"indicative":true}
```

`USDSUI` is a dollar-pegged asset, so the number is **naira per dollar**. A client that divides a naira amount by it gets dollars, which is right for USDC by coincidence and wrong for anything else by that asset's price.

The onramp had exactly this defect and it cost real money: ₦1,000 bought 0.6 XLM instead of 3.6. `GET /onramp/rate` now **requires** a `coin` and refuses without one, with a comment explaining why. The offramp was never given the same treatment, and the only thing hiding it is that the web cash-out happens to be USDC-only.

### What to build
- `GET /offramp/rate` takes a `coin` and answers in naira per unit of **that** asset, reusing `ngnPerCoin` from the onramp side rather than a second price path.
- Refusing a request with no coin is the right default, for the same reason the onramp refuses — but check who calls this first, because the web wallet does and must be updated in the same change or immediately after.
- The response should say which asset it priced, as the onramp's does.

### Acceptance criteria
- [ ] The rate for XLM differs from the rate for USDC, and a test pins both
- [ ] A request naming no coin cannot silently receive a dollar rate
- [ ] `frontend/wallet/lib/offramp.ts` passes a coin, and a cash-out still quotes correctly
- [ ] A test fails if the response is ever naira-per-dollar for a non-dollar asset

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### W081 · The mainnet indexer never starts, and reads serve stale data without saying so

**Labels:** help wanted, Stellar Wave, area:infra, difficulty:advanced, epic:observability

### Background
Every deploy prints this and carries on:

```
[indexer/mainnet] NOT STARTED — SOROBAN_RPC_URL_MAINNET is required to index mainnet.
[indexer/mainnet] Reads for this network will serve whatever is already indexed and fall behind until it is configured.
```

The service is otherwise healthy, `/status` reports `"network":"testnet"`, and mainnet reads answer with whatever was last indexed. A caller cannot distinguish "there are no transfers" from "nothing has looked at this chain since September", which is the exact conflation `src/middleware/network.ts` argues against for un-indexed networks — and then permits here.

### What to build
- A mainnet read must not answer as though it were current when the indexer for that network is not running. Decide between refusing and answering with an explicit staleness marker, and write down why.
- `/status` must surface per-network indexer state plainly enough that a dashboard can alert on it.
- Starting from an unconfigured state should be loud at the point of use, not only at boot where it scrolls past.

### Acceptance criteria
- [ ] A mainnet read while the mainnet indexer is stopped is distinguishable from an empty result
- [ ] `/status` reports each network's indexer as running or not, and how far behind
- [ ] A test covers the unconfigured-RPC path rather than only the happy one
- [ ] The README says which variable is required for which network

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### W082 · The OpenAPI coverage test has been red, so the spec is drifting unnoticed

**Labels:** help wanted, Stellar Wave, area:backend, difficulty:intermediate, epic:ci

### Background
`src/__tests__/openapiCoverage.test.ts` — "every route registered on the app appears in the generated spec" — fails on `main` and has for some time. It exists to stop the published API drifting from the real one, and a permanently red test does the opposite: it trains everyone to ignore the one signal that would catch a missing route.

It also takes 40–50 seconds and its result has been seen to flap between runs, which is worth understanding while you are in there.

### What to build
- Find which routes are missing from the spec and add them, or correct the test if it is the test that is wrong.
- Work out why it flaps. A coverage check over a fixed route table should be deterministic; if it is not, that is a second bug.
- Make it fast enough that nobody is tempted to skip it.

### Acceptance criteria
- [ ] The suite passes on `main`
- [ ] Ten consecutive runs give the same result
- [ ] Adding a route without documenting it fails the suite, proven by a commit that does exactly that and is then reverted
- [ ] The PR names every route that was missing

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W083 · Logs are prose, and prose cannot be searched when it matters

**Labels:** help wanted, Stellar Wave, area:infra, difficulty:intermediate, epic:observability

### Background
Diagnosing the KYC outage meant asking an operator to scroll Render's log viewer for a bracketed string. They could not find it, and there was no way to tell "the call is not being logged" from "the log line exists and the search did not match" — which cost most of an afternoon.

Logging today is `console.warn` with interpolated prose. There is no level, no request id, no route field, and nothing a log search can filter on reliably.

### What to build
- Structured logs — one JSON object per line, with at least level, event, route, status and duration.
- A request id that travels from the inbound request through the provider call, so one user's report can be traced end to end.
- Keep the deliberate omissions: no NIN, no API key, no connection string, no account number. The existing code is careful about this and the new logger must make it easy to stay careful.

### Acceptance criteria
- [ ] Every provider call logs one line with route, status and elapsed ms
- [ ] A test asserts no logged line contains a NIN, an API key or a connection string
- [ ] A single request can be followed across the API and provider boundary by one id
- [ ] The README says how to find one user's requests from a support report

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W084 · `/status` is healthy while the thing the money depends on is down

**Labels:** help wanted, Stellar Wave, area:infra, difficulty:intermediate, epic:observability

### Background
`/status` reports the indexer, the ledger lag and uptime. It said `"ok": true, "status": "healthy"` throughout an outage in which no user could complete identity verification, because the provider's KYC endpoint was returning 5xx and nothing watches it.

The service was, strictly, healthy. The product was not, and nothing in the system could tell the difference.

### What to build
- A dependency section in `/status` covering the provider endpoints the product actually needs, with the last observed status and when it was observed.
- Checks must be cheap and must not create anything. `GET /b2b/rate` is unauthenticated and side-effect free; a KYC probe is not, so do not invent one — report the last real call's outcome instead.
- Decide deliberately whether a failing dependency makes the service unhealthy or merely degraded, and say which in the response.

### Acceptance criteria
- [ ] `/status` distinguishes "this service is up" from "the rails are usable"
- [ ] No probe creates a customer, an order or a verification attempt
- [ ] A dependency failure is visible in `/status` within a bounded time, and the bound is stated
- [ ] A test covers the degraded response shape

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W085 · Nothing records what the platform fee actually charged

**Labels:** help wanted, Stellar Wave, area:backend, difficulty:advanced, epic:fees

### Background
`GET /fees` tells a client what to charge and where to send it; the client builds the payment and the fee rides in the same transaction. Nothing on this side records that it happened.

So there is no answer to: how much has been collected, from how many transactions, in which asset, on which day. The only record is on-chain and scattered across the treasury account's history, with nothing tying a payment to the request that priced it.

The fee is also now policy rather than a constant — percent, floor and cap — which means a misconfiguration can overcharge every user until somebody notices by reading a block explorer.

### What to build
- Record each quote: the amount priced against, the asset, the fee returned, the policy in force. No personal data, no address that is not already public.
- An endpoint or query that answers "what was charged today, and under what policy".
- An alarm condition for a fee that exceeds a sane proportion of the amount it was quoted against.

### Acceptance criteria
- [ ] Every `/fees` quote that returns a fee is recorded with the policy that produced it
- [ ] Collected totals can be reported per asset and per day
- [ ] A policy change is visible in the record, so a fee can be explained after the fact
- [ ] Nothing recorded identifies a person

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### W086 · The naira amount scale is trusted, never checked

**Labels:** help wanted, Stellar Wave, area:backend, difficulty:intermediate, epic:ngn-rails

### Background
The provider reported on 2026-10-14 that onramp naira amounts on their dashboard, and `amountNGN` in their webhooks, had been **100× too small**, and that it was now corrected. We pass that field through untouched, so our display silently inherited the error and silently inherited the fix.

Nothing in this service would have noticed either. A field that can change scale by two orders of magnitude without a test failing is a field that will do it again.

### What to build
- A sanity bound on naira amounts crossing the provider boundary, in both directions, rejecting or flagging values outside a plausible range for the order they belong to.
- The webhook's `amountNGN` cross-checked against the order's own naira amount, since both are known.
- A test that fails if the scale changes, with a fixture captured from a real payload shape.

### Acceptance criteria
- [ ] A webhook whose amount is 100× off its order is rejected or flagged, not stored silently
- [ ] The bound is justified in a comment, not a magic number
- [ ] A test pins the expected scale and fails if it changes
- [ ] Existing stored rows are checked once for the old scale, and the finding is written in the PR

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W087 · The provider's documented failure codes have no fixtures

**Labels:** help wanted, Stellar Wave, area:backend, difficulty:advanced, epic:ngn-rails

### Background
The provider documented their KYC failure codes on 2026-10-14: `invalid_nin_format` (400), `nin_already_used` (409), `nin_verification_failed` (422), `kyc_provider_error` (502), `kyc_internal_error` (500). Both clients now branch on these, and the mobile and web apps show different copy per code.

There is no fixture for any of them. Every one of those branches is untested against the shape it claims to handle, which is how the previous round of error handling came to read fields the provider never sent.

### What to build
- A fixture per documented code, as the provider returns it, in one place both the backend tests and the client tests can read.
- Tests that the API layer forwards each code unchanged to the caller.
- A deliberate test for an **undocumented** code and for a body with no code at all, since both have happened and both must degrade to something honest rather than a guess.

### Acceptance criteria
- [ ] Every documented code has a fixture and a test
- [ ] An unknown code is passed through, not mapped onto a known one
- [ ] A body with no readable message does not produce a message that implies a cause
- [ ] The fixtures are shared, so the clients cannot drift from the backend's idea of the shape

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### W088 · Lookups are rate-limited; the routes that move money are not

**Labels:** help wanted, Stellar Wave, area:security, difficulty:intermediate, epic:security

### Background
`GET /ngn/customers/status` carries a `lookupLimiter`, with a good reason in its comment: references are derived from wallet addresses, so an unthrottled endpoint is an oracle.

`POST /ngn/customers`, `POST /ngn/customers/kyc` and `POST /ngn/onramp/orders` carry none. Those are the routes that create records with a third party, spend a provider's rate limit, and consume a user's one-per-lifetime NIN attempt.

### What to build
- Rate limits on the creating routes, scoped per customer reference as well as per IP, since one abusive caller with many references is the shape that matters here.
- A refusal that is distinguishable from the provider's own 429, so a user is not told the wrong thing.
- Check what the provider's limits are first and stay comfortably inside them.

### Acceptance criteria
- [ ] Each creating route has a limit, and a test proves it refuses past it
- [ ] The limit is per reference as well as per address
- [ ] Our refusal and the provider's are distinguishable in the response
- [ ] The limits are configurable without a deploy, and the defaults are justified

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W089 · There is no end-to-end test of the naira rails, because there is nothing to test against

**Labels:** help wanted, Stellar Wave, area:backend, difficulty:advanced, epic:ngn-rails

### Background
The provider has no sandbox — every call moves real money or real personal data — so the only safe test is a fake. Today there is none, and every suite mocks `global.fetch` per test with ad-hoc shapes. The result is that each test asserts against the shape its author imagined rather than the one the provider sends, which is exactly how a client came to read fields that never existed.

A whole flow — provision, verify, quote, order, webhook, settle — has never been exercised in one piece.

### What to build
- A fake provider: one module implementing the documented endpoints and their documented failures, usable from any suite.
- An end-to-end test walking the full onramp against it, including the webhook arriving and the order reaching a terminal state.
- The fake must be the only place the provider's shapes are written down, so correcting it corrects every test at once.

### Acceptance criteria
- [ ] One fake, used by the existing suites in place of ad-hoc fetch mocks
- [ ] A test covers the full happy path end to end
- [ ] A test covers a failure at each step, using the documented codes
- [ ] No test reaches the real provider, enforced rather than assumed

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### W090 · Idempotency is claimed in comments and nowhere proven

**Labels:** help wanted, Stellar Wave, area:backend, difficulty:intermediate, epic:ngn-rails

### Background
`provisionCustomer` is documented as safe to retry: "a client retrying after a dropped response cannot create two customers for one person." Order creation takes an `idempotencyKey`. Both claims rest on the provider's behaviour and on ours, and neither is covered by a test.

This matters more now that W079 adds retries to a route that did not have them. A retry is only safe if the thing it retries is.

### What to build
- Tests that the same request twice produces one record, for each route that claims it.
- Where the claim depends on the provider, a test against the fake from W089 that encodes what we believe their behaviour to be — so a change in it fails here rather than in production.
- An honest note anywhere the guarantee is weaker than the comment implies.

### Acceptance criteria
- [ ] Every route documented as idempotent has a test proving it
- [ ] A dropped-response retry is covered, not just a duplicate request
- [ ] The idempotency key's scope and lifetime are written down
- [ ] Any claim that turns out to be unprovable is corrected in the comment rather than left standing

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W091 · `.env.example` no longer describes what this service needs to run

**Labels:** help wanted, Stellar Wave, area:docs, difficulty:easy, epic:onboarding

### Background
The fee policy alone added `VEIL_FEE_PERCENT`, `VEIL_FEE_MIN`, `VEIL_FEE_MAX`, `VEIL_FEE_MIN_XLM` and `VEIL_FEE_MAX_XLM` in one change. `SOROBAN_RPC_URL_MAINNET` is required for mainnet indexing and its absence is only discovered from a boot log. A new contributor cannot tell which variables are required, which are optional, and which have defaults that are wrong for them.

### What to build
- An `.env.example` listing every variable the service reads, grouped, each with one line saying what it does and whether it is required.
- A startup check that names every missing **required** variable at once rather than failing on the first one at the moment it is used.
- Nothing secret in the file. Placeholders only, and no real endpoint that embeds a key.

### Acceptance criteria
- [ ] Every `process.env` read in `src/` appears in the example
- [ ] A test fails when a new variable is read without being documented
- [ ] Booting without a required variable names all of them, not one
- [ ] The file contains no real key, token or keyed URL

> **Drips Wave** · Complexity: **Easy** · **100 points**

---
