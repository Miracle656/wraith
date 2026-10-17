/**
 * Typed access to `fixtures/linq/kyc-errors.json`, the KYC failure shapes the
 * backend and both Veil clients test against.
 *
 * Read from disk rather than imported: the file lives outside `src/` on
 * purpose, so the clients can consume it without reaching into backend test
 * code, and `rootDir` would refuse an import from there.
 */
import { readFileSync } from "fs";
import { join } from "path";

export const KYC_ERRORS_PATH = join(__dirname, "../../../fixtures/linq/kyc-errors.json");

export type KycErrorKind = "documented" | "undocumented" | "no_code";

export interface KycErrorCase {
  id: string;
  kind: KycErrorKind;
  /** What Linq sends. Exactly one of `body` (JSON) or `rawBody` (verbatim text). */
  provider: { status: number; body?: unknown; rawBody?: string };
  /** What wraith answers on `POST /ngn/customers/kyc` for that provider response. */
  veil: { status: number; body: { error: string; code?: string } };
}

export interface KycErrorFixtures {
  description: string;
  documentedOn: string;
  documented: Record<string, number>;
  cases: KycErrorCase[];
}

export const kycErrorsRaw = readFileSync(KYC_ERRORS_PATH, "utf8");
export const kycErrors = JSON.parse(kycErrorsRaw) as KycErrorFixtures;

/** The text a provider response carries, as `fetch` would hand it over. */
export function providerText(c: KycErrorCase): string {
  return c.provider.rawBody ?? JSON.stringify(c.provider.body);
}

/** A `fetch` stub answering with this case's provider response. */
export function providerResponse(c: KycErrorCase) {
  const text = providerText(c);
  return {
    ok: c.provider.status >= 200 && c.provider.status < 300,
    status: c.provider.status,
    headers: new Headers(),
    text: async () => text,
  };
}
