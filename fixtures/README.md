# Shared fixtures

Response shapes that more than one codebase has to agree on. The backend's tests
read these files directly. The Veil mobile and web apps read the **same** files,
so a client cannot test against a shape the backend does not produce.

If you change a shape here, the backend suite fails until wraith produces it, and
every client suite fails until that client handles it. That is the point.

## `linq/kyc-errors.json`

Failure responses for identity verification by NIN (W087).

| Field | Meaning |
| --- | --- |
| `documented` | The provider's documented KYC failure codes (2026-10-14) and their HTTP statuses. |
| `cases[].kind` | `documented`, `undocumented` (a code the provider has sent but not documented), or `no_code` (no usable code and no usable message). |
| `cases[].provider` | What the provider sends to wraith: `status`, plus `body` (JSON) or `rawBody` (verbatim text, for non-JSON bodies). |
| `cases[].veil` | What wraith answers on `POST /ngn/customers/kyc` for that provider response. **This is what clients should test against.** |

### What the clients can rely on

- **`code` is forwarded verbatim.** It is never renamed, and an unknown code is
  never mapped onto a known one. A client must branch on `code`, and must have a
  default branch for codes it does not recognise.
- **No `code` means nobody said why.** When the provider gives no usable code,
  the `code` key is absent (not `null`, not `""`). `error` then says only that
  the request failed and its status; it never names a cause. Show generic copy.
- **A provider 5xx arrives as 502**, with its code intact: `kyc_internal_error`
  is sent as 500 by the provider and reaches clients as 502. Branch on `code`,
  not on status, for anything code-specific.
- **`invalid_nin_format` also comes from wraith itself.** The route checks the
  11-digit shape before spending a rate-limited verification attempt, and that
  refusal carries the same code as the provider's. One branch handles both.
- **`error` is prose for a person.** Never match on it; it changes when the
  provider rewords.

### Using it from a client repo

Pin to a commit, never to a branch, so the shape cannot change under you
silently, and bump the pin deliberately:

```sh
curl -fsSL -o test/fixtures/kyc-errors.json \
  https://raw.githubusercontent.com/Miracle656/wraith/<commit-sha>/fixtures/linq/kyc-errors.json
```

Then, for each case, feed `veil.status` and `veil.body` to the client's error
handling and assert the copy branch it picks — and that every `no_code` and
`undocumented` case lands in the generic branch.

### Rules for editing

- **No NIN, real or realistic.** A NIN is personal data under the NDPA. A test
  asserts the file contains no 11-digit run and no `nin` field.
- **Bodies must be ones the provider sends.** The codes and statuses come from
  the provider's documentation. The `message` prose in the documented cases is
  representative, not captured verbatim; replace it with the real text when a
  response is captured, rather than adding fields nobody has seen sent.
- The documented code list is restated in
  `src/__tests__/linq/kycErrorFixtures.test.ts`, so editing this file alone cannot
  redefine what the provider documented.
