/**
 * W087 — the provider's documented KYC failure codes, against the shape they
 * actually arrive in.
 *
 * Both Veil clients branch on these codes and show different copy for each.
 * Until now nothing tested a single one of them end to end: the route tests
 * hand-built a `LinqError` and skipped the parser, which is exactly how the
 * previous round of error handling came to read fields the provider never
 * sent. Here every case in `fixtures/linq/kyc-errors.json` goes through the
 * real parser and the real route, with only `global.fetch` replaced.
 *
 * The fixture file is the contract. The clients read the same file, so if
 * this suite and theirs both pass, they agree on what wraith sends.
 *
 * Nothing here can reach the provider: `global.fetch` is a stub for every
 * test, and the naira rails have no sandbox to fall back on if it were not.
 */
import express from "express";
import request from "supertest";

import { createNgnRouter } from "../../api/ngn";
import { networkMiddleware } from "../../middleware/network";
import { LinqError } from "../../linq/client";
import { submitCustomerKyc } from "../../linq/onramp";
import {
  kycErrors,
  kycErrorsRaw,
  providerResponse,
  type KycErrorCase,
} from "../fixtures/kycErrors";

// The order table is Prisma-backed and irrelevant to KYC; keep the database out.
jest.mock("../../linq/ngnOrders", () => ({
  recordNgnOrder: jest.fn().mockResolvedValue(undefined),
  findNgnOrder: jest.fn().mockResolvedValue(null),
}));

/**
 * The provider's documentation of 2026-10-14, restated here rather than read
 * from the fixture, so that editing the fixture cannot quietly redefine it.
 */
const DOCUMENTED: Record<string, number> = {
  invalid_nin_format: 400,
  nin_already_used: 409,
  nin_verification_failed: 422,
  kyc_provider_error: 502,
  kyc_internal_error: 500,
};

/**
 * Plainly not a person's NIN. It has to be eleven digits to get past the
 * route's own shape check and reach the (stubbed) provider at all.
 */
const TEST_NIN = "00000000000";

const byKind = (kind: KycErrorCase["kind"]) => kycErrors.cases.filter((c) => c.kind === kind);
const asRows = (cases: KycErrorCase[]) => cases.map((c) => [c.id, c] as const);

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(networkMiddleware);
  app.use("/ngn", createNgnRouter());
  return app;
}

function postKyc(nin = TEST_NIN) {
  return request(makeApp())
    .post("/ngn/customers/kyc")
    .set("x-network", "mainnet")
    .send({ customerRef: "veil_fixture_customer", nin });
}

function stubProvider(c: KycErrorCase): jest.Mock {
  const stub = jest.fn().mockResolvedValue(providerResponse(c));
  global.fetch = stub as never;
  return stub;
}

beforeEach(() => {
  process.env.LINQ_API_KEY = "biz_live_test";
  process.env.NETWORKS = "testnet,mainnet";
  jest.restoreAllMocks();
  // The parser logs every non-2xx body; that is its job, not this suite's.
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

describe("the fixture file", () => {
  it("lists exactly the documented codes, at their documented statuses", () => {
    expect(kycErrors.documented).toEqual(DOCUMENTED);
  });

  it.each(Object.entries(DOCUMENTED))("has one documented case for %s (%i)", (code, status) => {
    const cases = byKind("documented").filter(
      (c) => (c.provider.body as { code?: string } | undefined)?.code === code,
    );
    expect(cases).toHaveLength(1);
    expect(cases[0].provider.status).toBe(status);
    expect(cases[0].veil.body.code).toBe(code);
  });

  it("has an undocumented-code case and a no-code case to degrade against", () => {
    expect(byKind("undocumented").length).toBeGreaterThan(0);
    expect(byKind("no_code").length).toBeGreaterThan(0);
  });

  // A NIN is personal data under the NDPA. A fixture is committed, copied into
  // two other repos, and read by anyone — it must not hold anything that could
  // pass for one, and must not model a NIN as a field of any response.
  it("contains nothing that could pass for a NIN", () => {
    expect(kycErrorsRaw).not.toMatch(/\d{11}/);
    for (const c of kycErrors.cases) {
      expect(c.provider.body ?? {}).not.toHaveProperty("nin");
      expect(c.veil.body).not.toHaveProperty("nin");
    }
  });

  it("gives every case exactly one of body or rawBody, and unique ids", () => {
    for (const c of kycErrors.cases) {
      expect([c.provider.body, c.provider.rawBody].filter((v) => v !== undefined)).toHaveLength(1);
    }
    const ids = kycErrors.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("submitCustomerKyc parses each fixture", () => {
  it.each(asRows(kycErrors.cases))("%s", async (_id, c) => {
    stubProvider(c);

    const err = await submitCustomerKyc("veil_fixture_customer", TEST_NIN).catch((e) => e);

    expect(err).toBeInstanceOf(LinqError);
    expect(err.status).toBe(c.provider.status);
    expect(err.code).toBe(c.veil.body.code);
    expect(err.message).toBe(c.veil.body.error);
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(TEST_NIN);
  });
});

describe("POST /ngn/customers/kyc forwards each fixture to the caller", () => {
  it.each(asRows(kycErrors.cases))("%s", async (_id, c) => {
    const stub = stubProvider(c);

    const res = await postKyc();

    // The provider was "called" — through the stub, at the KYC path — so this
    // exercised the real parser rather than a short-circuit.
    expect(stub).toHaveBeenCalled();
    expect(String(stub.mock.calls[0][0])).toContain("/b2b/customers/kyc");

    expect(res.status).toBe(c.veil.status);
    expect(res.body).toEqual(c.veil.body);
    expect(JSON.stringify(res.body)).not.toContain(TEST_NIN);
  });

  // A 5xx is ours to own as a 502 — the caller did nothing wrong — but the
  // code is what the clients branch on, and it must arrive untouched.
  it.each(asRows(byKind("documented")))("%s: the code arrives verbatim", async (_id, c) => {
    stubProvider(c);
    const res = await postKyc();
    expect(res.body.code).toBe((c.provider.body as { code: string }).code);
    expect(res.status).toBe(c.provider.status >= 500 ? 502 : c.provider.status);
  });
});

describe("an undocumented code", () => {
  // Mapping an unknown code onto the nearest known one is a guess, and a guess
  // here sends a person down the wrong branch with confident copy. Passing it
  // through lets the client fall to its generic case honestly.
  it.each(asRows(byKind("undocumented")))("%s is passed through, not mapped", async (_id, c) => {
    stubProvider(c);
    const res = await postKyc();

    const sent = (c.provider.body as { code: string }).code;
    expect(sent in DOCUMENTED).toBe(false);
    expect(res.body.code).toBe(sent);
    expect(Object.keys(DOCUMENTED)).not.toContain(res.body.code);
  });
});

describe("a body with no readable reason", () => {
  // Words that would tell a person *why* it failed. None was sent, so none may
  // appear: the KYC screen guessed "check your name" three times in a row off
  // a fallback that said nothing, and was wrong each time.
  const IMPLIES_A_CAUSE = /\bnin\b|identity|verif|format|already|name|customer|invalid|mismatch/i;

  it.each(asRows(byKind("no_code")))("%s: no code, and no implied cause", async (_id, c) => {
    stubProvider(c);
    const res = await postKyc();

    expect(res.body).not.toHaveProperty("code");
    expect(res.body.error).not.toMatch(IMPLIES_A_CAUSE);
    for (const code of Object.keys(DOCUMENTED)) expect(res.body.error).not.toContain(code);
    // A provider failure is not the request being turned down.
    if (c.provider.status >= 500) expect(res.body.error).not.toMatch(/reject/i);
  });
});

describe("the route's own NIN shape check", () => {
  // Most malformed NINs never reach the provider: the route refuses them to
  // save a rate-limited attempt. They must still carry the documented code, or
  // the clients' `invalid_nin_format` branch is unreachable in practice.
  it.each(["0000000000", "000000000000", "0000000000a", ""])(
    "answers %p with the provider's invalid_nin_format shape, without calling it",
    async (nin) => {
      const stub = jest.fn();
      global.fetch = stub as never;

      const res = await postKyc(nin);

      expect(stub).not.toHaveBeenCalled();
      const documented = kycErrors.cases.find((c) => c.id === "invalid_nin_format")!;
      expect(res.status).toBe(documented.veil.status);
      expect(res.body.code).toBe(documented.veil.body.code);
      expect(typeof res.body.error).toBe("string");
    },
  );
});
