# Event Reference

This page documents every Soroban contract event the indexer recognizes, along
with its on-the-wire shape, where each field comes from, and a worked example
with real XDR.

The indexer follows the [SEP-41](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md)
/ CAP-67 token event standard. A contract event is identified by its first topic
(`topics[0]`), which is a `Symbol` naming the event type. The recognized set is
defined by `KNOWN_EVENT_TYPES` in [src/decoder.ts](../src/decoder.ts):

```ts
const KNOWN_EVENT_TYPES = new Set(["transfer", "mint", "burn", "clawback"]);
```

Any event whose `topics[0]` symbol is not in this set is silently skipped
(see [`parseEvents`](../src/decoder.ts)).

## How events are decoded

Every recognized event is normalized into a single `TransferRecord`
([src/db.ts](../src/db.ts)):

| Field            | Type            | Source                                            |
| ---------------- | --------------- | ------------------------------------------------- |
| `contractId`     | `string`        | RPC event `contractId` (the `C...` token contract) |
| `eventType`      | `string`        | `topics[0]` symbol, lower-cased                    |
| `fromAddress`    | `string \| null`| address topic, varies by event (see below)        |
| `toAddress`      | `string \| null`| address topic, varies by event (see below)        |
| `amount`         | `string`        | event `value`, an `i128` rendered as a decimal string |
| `ledger`         | `number`        | RPC event `ledger`                                 |
| `ledgerClosedAt` | `Date`          | RPC event `ledgerClosedAt`                         |
| `txHash`         | `string`        | RPC event `txHash`                                 |
| `eventId`        | `string`        | RPC event `id` (paging token)                      |

Decoding helpers ([src/decoder.ts](../src/decoder.ts)):

- **Symbol** (`topics[0]`) → `scValToNative` → string, then lower-cased.
- **Address** (`scvAddress`) → `Address.fromScVal(...).toString()` → a `G...`
  (account) or `C...` (contract) strkey.
- **Amount** (`scvI128`) → `scValToNative` → `bigint` → decimal string. The raw
  value is in stroops (7 decimal places); a value of `1000000000` is `100.0000000`
  of the token. `amount` is always stored as the raw integer string; the display
  conversion lives in `toDisplayAmount` ([src/db.ts](../src/db.ts)).

The XDR strings below are base64-encoded `ScVal`s, identical to the fixtures in
[src/\_\_tests\_\_/fixtures/events.json](../src/__tests__/fixtures/events.json) and
exercised in [src/\_\_tests\_\_/decoder.test.ts](../src/__tests__/decoder.test.ts).
You can reproduce any decode with:

```ts
import { xdr, scValToNative } from "@stellar/stellar-sdk";
scValToNative(xdr.ScVal.fromXDR("<base64>", "base64"));
```

---

## `transfer`

A token balance moved from one holder to another. This is the most common event.

**Shape**

| Position    | ScVal type   | Meaning            |
| ----------- | ------------ | ------------------ |
| `topics[0]` | `Symbol`     | `"transfer"`       |
| `topics[1]` | `Address`    | `from` (sender)    |
| `topics[2]` | `Address`    | `to` (recipient)   |
| `value`     | `i128`       | `amount`           |

**Source → record:** `fromAddress = topics[1]`, `toAddress = topics[2]`,
`amount = value`. Requires at least 3 topics; a malformed transfer (missing or
non-address topics) throws.

**Example XDR**

```json
{
  "topic": [
    "AAAADwAAAAh0cmFuc2Zlcg==",
    "AAAAEgAAAAAAAAAA7CdvsKYgszvP+5duBzZrGGNSzXrjV6xBqb+G1HlVBos=",
    "AAAAEgAAAAAAAAAArud9yE50cjsuGtxESbV3hBerj0SikWcRLPfz/uY41h0="
  ],
  "value": "AAAACgAAAAAAAAAAAAAAADuaygA="
}
```

**Decoded**

```jsonc
{
  "eventType":   "transfer",
  "fromAddress": "GDWCO35QUYQLGO6P7OLW4BZWNMMGGUWNPLRVPLCBVG7YNVDZKUDIW4KN",
  "toAddress":   "GCXOO7OIJZ2HEOZODLOEISNVO6CBPK4PISRJCZYRFT37H7XGHDLB3C7O",
  "amount":      "1000000000"   // 100.0000000 of the token
}
```

---

## `mint`

New tokens were created and credited to a recipient. There is no sender, so
`fromAddress` is `null`.

**Shape**

| Position    | ScVal type   | Meaning                          |
| ----------- | ------------ | -------------------------------- |
| `topics[0]` | `Symbol`     | `"mint"`                         |
| `topics[1]` | `Address`    | `admin` (the minter — **ignored**) |
| `topics[2]` | `Address`    | `to` (recipient)                 |
| `value`     | `i128`       | `amount`                         |

**Source → record:** `fromAddress = null`, `toAddress = topics[2]`,
`amount = value`. Note `topics[1]` (the admin/minter) is **not** recorded as the
sender — a mint creates supply rather than moving it. Requires at least 3 topics.

**Example XDR**

```json
{
  "topic": [
    "AAAADwAAAARtaW50",
    "AAAAEgAAAAAAAAAA7CdvsKYgszvP+5duBzZrGGNSzXrjV6xBqb+G1HlVBos=",
    "AAAAEgAAAAAAAAAArud9yE50cjsuGtxESbV3hBerj0SikWcRLPfz/uY41h0="
  ],
  "value": "AAAACgAAAAAAAAAAAAAAASoF8gA="
}
```

**Decoded**

```jsonc
{
  "eventType":   "mint",
  "fromAddress": null,
  "toAddress":   "GCXOO7OIJZ2HEOZODLOEISNVO6CBPK4PISRJCZYRFT37H7XGHDLB3C7O",
  "amount":      "5000000000"   // 500.0000000 of the token
}
```

---

## `burn`

Tokens were destroyed, removing them from a holder's balance and from supply.
There is no recipient, so `toAddress` is `null`.

**Shape**

| Position    | ScVal type   | Meaning                       |
| ----------- | ------------ | ----------------------------- |
| `topics[0]` | `Symbol`     | `"burn"`                      |
| `topics[1]` | `Address`    | `from` (holder being burned)  |
| `value`     | `i128`       | `amount`                      |

**Source → record:** `fromAddress = topics[1]`, `toAddress = null`,
`amount = value`. Requires at least 2 topics.

**Example XDR**

```json
{
  "topic": [
    "AAAADwAAAARidXJu",
    "AAAAEgAAAAAAAAAA7CdvsKYgszvP+5duBzZrGGNSzXrjV6xBqb+G1HlVBos="
  ],
  "value": "AAAACgAAAAAAAAAAAAAAAAAAAGQ="
}
```

**Decoded**

```jsonc
{
  "eventType":   "burn",
  "fromAddress": "GDWCO35QUYQLGO6P7OLW4BZWNMMGGUWNPLRVPLCBVG7YNVDZKUDIW4KN",
  "toAddress":   null,
  "amount":      "100"          // 0.0000100 of the token
}
```

---

## `clawback`

An admin reclaimed tokens from a holder. Structurally identical to `burn`: the
balance leaves `from` and there is no recipient, so `toAddress` is `null`.

**Shape**

| Position    | ScVal type   | Meaning                          |
| ----------- | ------------ | -------------------------------- |
| `topics[0]` | `Symbol`     | `"clawback"`                     |
| `topics[1]` | `Address`    | `from` (account being clawed back) |
| `value`     | `i128`       | `amount`                         |

**Source → record:** `fromAddress = topics[1]`, `toAddress = null`,
`amount = value`. Requires at least 2 topics.

**Example XDR**

```json
{
  "topic": [
    "AAAADwAAAAhjbGF3YmFjaw==",
    "AAAAEgAAAAAAAAAA7CdvsKYgszvP+5duBzZrGGNSzXrjV6xBqb+G1HlVBos="
  ],
  "value": "AAAACgAAAAAAAAAAAAAAAAAAAMg="
}
```

**Decoded**

```jsonc
{
  "eventType":   "clawback",
  "fromAddress": "GDWCO35QUYQLGO6P7OLW4BZWNMMGGUWNPLRVPLCBVG7YNVDZKUDIW4KN",
  "toAddress":   null,
  "amount":      "200"          // 0.0000200 of the token
}
```

---

## A note on `approve`

SEP-41 tokens also emit an `approve` (allowance) event. The indexer **does not**
recognize it: `approve` sets a spending allowance and does not move a balance, so
it has no place in the balance-movement model captured by `TransferRecord`. Any
`approve` event is skipped along with all other unrecognized topics. If allowance
tracking is needed in the future, add `"approve"` to `KNOWN_EVENT_TYPES` and a
branch in [`parseEvent`](../src/decoder.ts) — note its `value` is a struct
(`{ amount, expiration_ledger }`) rather than a bare `i128`.

## Summary

| Event      | `topics[1]` | `topics[2]` | `from`        | `to`        | `value` |
| ---------- | ----------- | ----------- | ------------- | ----------- | ------- |
| `transfer` | `from`      | `to`        | `topics[1]`   | `topics[2]` | `i128`  |
| `mint`     | `admin`     | `to`        | `null`        | `topics[2]` | `i128`  |
| `burn`     | `from`      | —           | `topics[1]`   | `null`      | `i128`  |
| `clawback` | `from`      | —           | `topics[1]`   | `null`      | `i128`  |
