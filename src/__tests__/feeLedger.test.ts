/**
 * W085 — the platform fee ledger.
 *
 * `GET /fees` tells a client what to charge, and the fee then rides on-chain
 * in the user's own transaction. Nothing on this side knew it had happened.
 * These pin the four things the issue asks for:
 *
 *  - every quote that returns a fee is recorded, with the policy behind it;
 *  - totals can be reported per asset and per day;
 *  - a policy change is visible, so a fee can be explained after the fact;
 *  - nothing recorded identifies a person.
 *
 * Plus the alarm, and the property that matters most in production: a ledger
 * failure never fails the quote a person is in the middle of paying.
 *
 * The database is mocked throughout; nothing here touches a provider.
 */
import express from "express";
import request from "supertest";
import { Asset, Networks } from "@stellar/stellar-sdk";

jest.mock("../db", () => ({
  prisma: {
    feePolicy: { createMany: jest.fn(), findMany: jest.fn() },
    feeQuote: { createMany: jest.fn() },
    $queryRaw: jest.fn(),
  },
}));
jest.mock("../indexer", () => ({ resolveSacContractIds: jest.fn() }));

import { prisma } from "../db";
import { resolveSacContractIds } from "../indexer";
import { networkMiddleware } from "../middleware/network";
import { feeBasis, feesRouter, reportRange, type PlatformFee } from "../api/fees";
import {
  DEFAULT_ALARM_PERCENT,
  _forgetKnownPolicies,
  alarmPercent,
  feeReport,
  policyId,
  policyOf,
  quoteRow,
  recordFeeQuotes,
} from "../api/feeLedger";
import { feeQuoteAlarmsTotal, feeQuoteRecordFailuresTotal, _resetMetrics } from "../metrics";

const db = prisma as unknown as {
  feePolicy: { createMany: jest.Mock; findMany: jest.Mock };
  feeQuote: { createMany: jest.Mock };
  $queryRaw: jest.Mock;
};

const DESTINATION = "GB3JS2AJZ3FKIGVOOPXDEYYR3XOHQA474WGCYAMNFSGX6OW5HGWCKUZW";
const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const TOKEN = "report-token-for-tests";

const FEE_ENV = [
  "VEIL_FEE_DESTINATION",
  "VEIL_FEE_ASSET_CODE",
  "VEIL_FEE_ASSET_ISSUER",
  "VEIL_FEE_AMOUNT",
  "VEIL_FEE_AMOUNT_XLM",
  "VEIL_FEE_PERCENT",
  "VEIL_FEE_MIN",
  "VEIL_FEE_MAX",
  "VEIL_FEE_MIN_XLM",
  "VEIL_FEE_MAX_XLM",
  "VEIL_FEE_ALARM_PERCENT",
  "VEIL_FEE_REPORT_TOKEN",
];

/** The exact columns a quote row may have. A new one must be argued for here. */
const QUOTE_COLUMNS = [
  "alarm",
  "assetCode",
  "assetIssuer",
  "basis",
  "fee",
  "feePercent",
  "network",
  "policyId",
  "quotedAgainst",
];

const percentFee = (over: Partial<PlatformFee> = {}): PlatformFee => ({
  amount: "0.5",
  assetCode: "USDC",
  assetIssuer: ISSUER,
  destination: DESTINATION,
  percent: "0.5",
  min: "0.02",
  max: "2",
  ...over,
});

const flatFee = (over: Partial<PlatformFee> = {}): PlatformFee => ({
  amount: "0.1",
  assetCode: "XLM",
  assetIssuer: null,
  destination: DESTINATION,
  ...over,
});

function makeApp() {
  const app = express();
  app.use(networkMiddleware);
  app.use("/fees", feesRouter());
  return app;
}

/** Let the fire-and-forget write after a response finish. */
const settle = () => new Promise((r) => setImmediate(r));

const quotesWritten = () => db.feeQuote.createMany.mock.calls.flatMap((c) => c[0].data);
const policiesWritten = () => db.feePolicy.createMany.mock.calls.flatMap((c) => c[0].data);

beforeEach(() => {
  for (const key of FEE_ENV) delete process.env[key];
  process.env.NETWORKS = "testnet,mainnet";
  jest.clearAllMocks();
  db.feePolicy.createMany.mockResolvedValue({ count: 1 });
  db.feeQuote.createMany.mockResolvedValue({ count: 1 });
  db.feePolicy.findMany.mockResolvedValue([]);
  db.$queryRaw.mockResolvedValue([]);
  (resolveSacContractIds as jest.Mock).mockReturnValue([]);
  _forgetKnownPolicies();
  _resetMetrics();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

afterAll(() => {
  for (const key of FEE_ENV) delete process.env[key];
});

// ─── Which rule decided the fee ─────────────────────────────────────────────

describe("feeBasis", () => {
  it("is flat when the policy has no percent", () => {
    expect(feeBasis(flatFee(), 10)).toBe("flat");
  });

  it("is no_amount when an old client sent nothing to price", () => {
    expect(feeBasis(percentFee({ amount: "0.02" }))).toBe("no_amount");
  });

  it("is percent when neither bound applied", () => {
    // 0.5% of 100 = 0.5, between 0.02 and 2.
    expect(feeBasis(percentFee({ amount: "0.5" }), 100)).toBe("percent");
  });

  it("is floor when the floor overrode a smaller percent", () => {
    // 0.5% of 1 = 0.005, under the 0.02 floor.
    expect(feeBasis(percentFee({ amount: "0.02" }), 1)).toBe("floor");
  });

  it("is cap when the cap overrode a larger percent", () => {
    // 0.5% of 10,000 = 50, over the 2 cap.
    expect(feeBasis(percentFee({ amount: "2" }), 10_000)).toBe("cap");
  });

  it("is percent, not floor, when the percent lands exactly on the floor", () => {
    // 0.5% of 4 = 0.02 — the floor did not change anything.
    expect(feeBasis(percentFee({ amount: "0.02" }), 4)).toBe("percent");
  });
});

// ─── Policies ───────────────────────────────────────────────────────────────

describe("policyOf / policyId", () => {
  it("leaves a percent quote's computed amount out of the policy", () => {
    // Otherwise every distinct send would look like a policy change.
    const a = policyOf(percentFee({ amount: "0.5" }));
    const b = policyOf(percentFee({ amount: "1.25" }));
    expect(a.amount).toBeNull();
    expect(policyId(a)).toBe(policyId(b));
  });

  it("keeps a flat fee's amount, because there it is the policy", () => {
    expect(policyOf(flatFee()).amount).toBe("0.1");
    expect(policyId(policyOf(flatFee({ amount: "0.1" })))).not.toBe(
      policyId(policyOf(flatFee({ amount: "0.2" }))),
    );
  });

  it.each([
    ["percent", { percent: "1" }],
    ["floor", { min: "0.05" }],
    ["cap", { max: "5" }],
    ["destination", { destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" }],
    ["asset", { assetCode: "EURC" }],
  ])("changes when the %s changes", (_what, change) => {
    expect(policyId(policyOf(percentFee(change)))).not.toBe(policyId(policyOf(percentFee())));
  });

  it("does not depend on the order the fields were built in", () => {
    const p = policyOf(percentFee());
    const reordered = { amount: p.amount, max: p.max, min: p.min, percent: p.percent, destination: p.destination, assetIssuer: p.assetIssuer, assetCode: p.assetCode, mode: p.mode };
    expect(policyId(reordered)).toBe(policyId(p));
  });
});

// ─── The row, and the alarm ─────────────────────────────────────────────────

describe("quoteRow", () => {
  it("records the amount priced, the fee, the basis and the policy", () => {
    const { data } = quoteRow("mainnet", 100, { fee: percentFee({ amount: "0.5" }), basis: "percent" });
    expect(data).toMatchObject({
      network: "mainnet",
      assetCode: "USDC",
      assetIssuer: ISSUER,
      quotedAgainst: "100",
      fee: "0.5",
      basis: "percent",
      feePercent: "0.5",
      alarm: false,
      policyId: policyId(policyOf(percentFee())),
    });
  });

  // The whole of the "nothing identifies a person" criterion, as a shape: the
  // row has exactly these columns, and none of them can hold an IP, a user
  // agent or a sender. The destination is in the policy, and `/fees`
  // publishes it to anyone.
  it("has no column that could identify a person", () => {
    const { data } = quoteRow("mainnet", 100, { fee: percentFee(), basis: "percent" });
    expect(Object.keys(data).sort()).toEqual(QUOTE_COLUMNS);
  });

  it("records no amount and raises no alarm when none was sent", () => {
    const { data } = quoteRow("mainnet", undefined, { fee: percentFee({ amount: "0.02" }), basis: "no_amount" });
    expect(data.quotedAgainst).toBeNull();
    expect(data.feePercent).toBeNull();
    expect(data.alarm).toBe(false);
  });

  it("alarms only above the limit, not at it", () => {
    const at = quoteRow("mainnet", 1, { fee: flatFee({ amount: "0.1" }), basis: "flat" }, 10);
    const over = quoteRow("mainnet", 1, { fee: flatFee({ amount: "0.1000001" }), basis: "flat" }, 10);
    expect(at.data.alarm).toBe(false);
    expect(over.data.alarm).toBe(true);
  });

  it("catches a floor that dwarfs a tiny send", () => {
    // A 0.02 floor on a 0.1 send is 20% of it.
    const { data } = quoteRow("mainnet", 0.1, { fee: percentFee({ amount: "0.02" }), basis: "floor" });
    expect(data.feePercent).toBe("20");
    expect(data.alarm).toBe(true);
  });
});

describe("alarmPercent", () => {
  it("defaults to 10", () => {
    expect(alarmPercent()).toBe(DEFAULT_ALARM_PERCENT);
    expect(DEFAULT_ALARM_PERCENT).toBe(10);
  });

  it("reads VEIL_FEE_ALARM_PERCENT", () => {
    process.env.VEIL_FEE_ALARM_PERCENT = "2.5";
    expect(alarmPercent()).toBe(2.5);
  });

  it.each(["0", "-1", "101", "abc", ""])("falls back to the default for %p", (value) => {
    process.env.VEIL_FEE_ALARM_PERCENT = value;
    expect(alarmPercent()).toBe(DEFAULT_ALARM_PERCENT);
  });
});

// ─── Recording ──────────────────────────────────────────────────────────────

describe("recordFeeQuotes", () => {
  it("writes each quote with its policy, and the policy only once", async () => {
    const quoted = [{ fee: percentFee(), basis: "percent" as const }];
    await recordFeeQuotes("mainnet", 100, quoted);
    await recordFeeQuotes("mainnet", 200, quoted);

    expect(db.feePolicy.createMany).toHaveBeenCalledTimes(1);
    expect(db.feePolicy.createMany.mock.calls[0][0].skipDuplicates).toBe(true);
    expect(policiesWritten()).toEqual([
      { id: policyId(policyOf(percentFee())), policy: policyOf(percentFee()) },
    ]);
    expect(quotesWritten()).toHaveLength(2);
  });

  it("does nothing when no fee was returned", async () => {
    await recordFeeQuotes("mainnet", 100, []);
    expect(db.feeQuote.createMany).not.toHaveBeenCalled();
    expect(db.feePolicy.createMany).not.toHaveBeenCalled();
  });

  it("raises the alarm: counter, log line, and the row's flag", async () => {
    await recordFeeQuotes("mainnet", 0.1, [{ fee: percentFee({ amount: "0.02" }), basis: "floor" }]);

    const counted = await feeQuoteAlarmsTotal.get();
    expect(counted.values).toEqual([
      expect.objectContaining({ value: 1, labels: { network: "mainnet", asset: "USDC" } }),
    ]);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/ALARM mainnet USDC: fee 0\.02 is 20% of 0\.1/));
    expect(quotesWritten()[0].alarm).toBe(true);
  });

  // The person is mid-payment. A ledger outage must be loud, not fatal.
  it("never throws when the database fails, and counts the failure", async () => {
    db.feeQuote.createMany.mockRejectedValue(new Error("connection refused"));

    await expect(
      recordFeeQuotes("mainnet", 100, [{ fee: percentFee(), basis: "percent" }]),
    ).resolves.toBeUndefined();

    const failures = await feeQuoteRecordFailuresTotal.get();
    expect(failures.values).toEqual([expect.objectContaining({ value: 1, labels: { network: "mainnet" } })]);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/could not record 1 fee quote/));
  });

  it("still raises the alarm when the write fails", async () => {
    db.feePolicy.createMany.mockRejectedValue(new Error("down"));
    await recordFeeQuotes("mainnet", 0.1, [{ fee: percentFee({ amount: "0.02" }), basis: "floor" }]);
    expect((await feeQuoteAlarmsTotal.get()).values[0]?.value).toBe(1);
  });

  it("retries a policy write that failed, rather than caching it as known", async () => {
    db.feePolicy.createMany.mockRejectedValueOnce(new Error("down"));
    const quoted = [{ fee: percentFee(), basis: "percent" as const }];
    await recordFeeQuotes("mainnet", 100, quoted);
    await recordFeeQuotes("mainnet", 100, quoted);
    expect(db.feePolicy.createMany).toHaveBeenCalledTimes(2);
  });
});

// ─── Through the route ──────────────────────────────────────────────────────

describe("GET /fees records what it quoted", () => {
  beforeEach(() => {
    process.env.VEIL_FEE_DESTINATION = DESTINATION;
    process.env.VEIL_FEE_ASSET_ISSUER = ISSUER;
    process.env.VEIL_FEE_PERCENT = "0.5";
    process.env.VEIL_FEE_MIN = "0.02";
    process.env.VEIL_FEE_MAX = "2";
    process.env.VEIL_FEE_AMOUNT_XLM = "0.1";
  });

  it("records every fee it returned, each with the policy that produced it", async () => {
    const res = await request(makeApp()).get("/fees?amount=100").set("x-network", "mainnet");
    await settle();

    expect(res.status).toBe(200);
    const returned = res.body.fees as Record<string, PlatformFee>;
    const rows = quotesWritten();
    expect(rows.map((r) => r.assetCode).sort()).toEqual(Object.keys(returned).sort());

    const policies = new Map(policiesWritten().map((p) => [p.id, p.policy]));
    for (const row of rows) {
      const fee = returned[row.assetCode];
      expect(row.fee).toBe(fee.amount);
      expect(row.network).toBe("mainnet");
      expect(row.quotedAgainst).toBe("100");
      // The policy recorded is the one the client was sent, field for field.
      expect(policies.get(row.policyId)).toEqual(policyOf(fee));
    }
    // VEIL_FEE_PERCENT applies to every asset; XLM's flat amount is its floor.
    expect(rows.map((r) => r.basis)).toEqual(["percent", "percent"]);
  });

  it("records a quote with no amount as the floor it told the client", async () => {
    await request(makeApp()).get("/fees").set("x-network", "mainnet");
    await settle();
    const usdc = quotesWritten().find((r) => r.assetCode === "USDC");
    expect(usdc).toMatchObject({ basis: "no_amount", quotedAgainst: null, fee: "0.02", alarm: false });
  });

  it("records nothing when no fee is configured", async () => {
    delete process.env.VEIL_FEE_DESTINATION;
    const res = await request(makeApp()).get("/fees?amount=100");
    await settle();
    expect(res.body.enabled).toBe(false);
    expect(db.feeQuote.createMany).not.toHaveBeenCalled();
  });

  it("still answers when the ledger is down", async () => {
    db.feePolicy.createMany.mockRejectedValue(new Error("down"));
    db.feeQuote.createMany.mockRejectedValue(new Error("down"));
    const res = await request(makeApp()).get("/fees?amount=100");
    await settle();
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
  });

  it("makes a policy change visible: a new policy row, and quotes that name it", async () => {
    await request(makeApp()).get("/fees?amount=100");
    await settle();
    process.env.VEIL_FEE_PERCENT = "1";
    await request(makeApp()).get("/fees?amount=100");
    await settle();

    const usdc = quotesWritten().filter((r) => r.assetCode === "USDC");
    expect(usdc).toHaveLength(2);
    expect(usdc[0].policyId).not.toBe(usdc[1].policyId);
    expect(usdc.map((r) => r.fee)).toEqual(["0.5", "1"]);

    const percents = policiesWritten()
      .filter((p) => p.policy.assetCode === "USDC")
      .map((p) => p.policy.percent);
    expect(percents).toEqual(["0.5", "1"]);
    // The percent is shared, so XLM's policy changed too — and is recorded.
    expect(policiesWritten().filter((p) => p.policy.assetCode === "XLM")).toHaveLength(2);
  });

  it("writes an unchanged policy once, however many quotes it prices", async () => {
    for (const amount of [1, 50, 100, 10_000]) {
      await request(makeApp()).get(`/fees?amount=${amount}`);
      await settle();
    }
    expect(quotesWritten()).toHaveLength(8);
    expect(policiesWritten()).toHaveLength(2);
    // ...and each basis is the rule that actually decided that fee.
    expect(quotesWritten().filter((r) => r.assetCode === "USDC").map((r) => r.basis)).toEqual([
      "floor",
      "percent",
      "percent",
      "cap",
    ]);
  });

  it("takes nothing from the request beyond the amount", async () => {
    await request(makeApp())
      .get("/fees?amount=100&address=GBUO4RL4RTGRFSUDUMRFMC75EWYCRTX5OE3PBIXJVDCZULOXQ2TKDR4Z")
      .set("user-agent", "VeilWallet/1.2 (Pixel 7)")
      .set("x-forwarded-for", "203.0.113.7");
    await settle();
    const written = JSON.stringify([quotesWritten(), policiesWritten()]);
    expect(written).not.toContain("GBUO4RL4");
    expect(written).not.toContain("Pixel");
    expect(written).not.toContain("203.0.113.7");
  });
});

// ─── Reporting ──────────────────────────────────────────────────────────────

describe("reportRange", () => {
  it("accepts a single day and an inclusive range", () => {
    expect(reportRange("2026-10-17", "2026-10-17")).toEqual({ from: "2026-10-17", to: "2026-10-17" });
    expect(reportRange("2026-10-01", "2026-10-17")).toEqual({ from: "2026-10-01", to: "2026-10-17" });
  });

  it.each([
    ["not a date", "yesterday", "2026-10-17"],
    ["an impossible date", "2026-02-30", "2026-03-01"],
    ["a reversed range", "2026-10-17", "2026-10-01"],
    ["more than 92 days", "2026-01-01", "2026-12-31"],
  ])("refuses %s", (_what, from, to) => {
    expect(typeof reportRange(from, to)).toBe("string");
  });
});

describe("GET /fees/report", () => {
  const auth = (r: request.Test) => r.set("authorization", `Bearer ${TOKEN}`).set("x-network", "mainnet");

  it("answers 503 when no report token is configured, so it is never open by accident", async () => {
    const res = await request(makeApp()).get("/fees/report").set("authorization", "Bearer anything");
    expect(res.status).toBe(503);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it.each([
    ["no token", undefined],
    ["a wrong token", "Bearer nope"],
    ["the right token without the scheme", TOKEN],
  ])("refuses %s", async (_what, header) => {
    process.env.VEIL_FEE_REPORT_TOKEN = TOKEN;
    const req = request(makeApp()).get("/fees/report");
    const res = await (header ? req.set("authorization", header) : req);
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toBe("Bearer");
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("refuses a bad range with 400", async () => {
    process.env.VEIL_FEE_REPORT_TOKEN = TOKEN;
    const res = await auth(request(makeApp()).get("/fees/report?from=2026-10-17&to=2026-10-01"));
    expect(res.status).toBe(400);
  });

  it("answers 500, not a stack trace, when the ledger cannot be read", async () => {
    process.env.VEIL_FEE_REPORT_TOKEN = TOKEN;
    db.$queryRaw.mockRejectedValue(new Error("relation does not exist"));
    const res = await auth(request(makeApp()).get("/fees/report?from=2026-10-17"));
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("relation");
  });

  it("defaults to today, UTC", async () => {
    process.env.VEIL_FEE_REPORT_TOKEN = TOKEN;
    const today = new Date().toISOString().slice(0, 10);
    const res = await auth(request(makeApp()).get("/fees/report"));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ from: today, to: today, days: [] });
  });

  it("reports per day and asset, with the policies and what was collected", async () => {
    process.env.VEIL_FEE_REPORT_TOKEN = TOKEN;
    const usdcPolicy = policyOf(percentFee());
    const xlmPolicy = policyOf(flatFee());
    const usdcId = policyId(usdcPolicy);
    const xlmId = policyId(xlmPolicy);
    const xlmSac = Asset.native().contractId(Networks.PUBLIC);
    // XLM's contract is indexed; USDC's is not.
    (resolveSacContractIds as jest.Mock).mockReturnValue([xlmSac]);

    db.$queryRaw
      .mockResolvedValueOnce([
        { day: "2026-10-16", assetCode: "USDC", assetIssuer: ISSUER, quotes: 3, feesQuoted: "1.0400000", alarms: 1, policyIds: [usdcId] },
        { day: "2026-10-16", assetCode: "XLM", assetIssuer: null, quotes: 2, feesQuoted: "0.2000000", alarms: 0, policyIds: [xlmId] },
        { day: "2026-10-17", assetCode: "XLM", assetIssuer: null, quotes: 1, feesQuoted: "0.1000000", alarms: 0, policyIds: [xlmId] },
      ])
      .mockResolvedValueOnce([
        { day: "2026-10-16", total: "2000000" },
        { day: "2026-10-15", total: "15000000" },
      ]);
    db.feePolicy.findMany.mockResolvedValue([
      { id: usdcId, policy: usdcPolicy, firstSeenAt: new Date("2026-10-01T09:00:00Z") },
      { id: xlmId, policy: xlmPolicy, firstSeenAt: new Date("2026-09-30T12:00:00Z") },
    ]);

    const res = await auth(request(makeApp()).get("/fees/report?from=2026-10-15&to=2026-10-17"));

    expect(res.status).toBe(200);
    expect(res.body.network).toBe("mainnet");
    expect(res.body.alarmPercent).toBe(10);
    expect(res.body.policies[usdcId]).toEqual({ firstSeenAt: "2026-10-01T09:00:00.000Z", policy: usdcPolicy });
    expect(res.body.days.map((d: { date: string }) => d.date)).toEqual(["2026-10-15", "2026-10-16", "2026-10-17"]);

    const [d15, d16, d17] = res.body.days;
    // Received with no quote that day: shown, not dropped.
    expect(d15.assets).toEqual([
      expect.objectContaining({ assetCode: "XLM", quotes: 0, feesQuoted: "0", collected: "1.5" }),
    ]);
    expect(d16.assets).toEqual([
      {
        assetCode: "USDC",
        assetIssuer: ISSUER,
        quotes: 3,
        feesQuoted: "1.04",
        alarms: 1,
        policyIds: [usdcId],
        collected: null,
        collectedNote: expect.stringMatching(/not indexed/),
      },
      { assetCode: "XLM", assetIssuer: null, quotes: 2, feesQuoted: "0.2", alarms: 0, policyIds: [xlmId], collected: "0.2" },
    ]);
    // Indexed and quoted, but nothing arrived: zero is a real answer here.
    expect(d17.assets[0]).toMatchObject({ assetCode: "XLM", collected: "0" });

    // Scoped to the network and the range asked for, with the end exclusive.
    const [, ...values] = db.$queryRaw.mock.calls[0];
    expect(values).toEqual(["mainnet", new Date("2026-10-15T00:00:00Z"), new Date("2026-10-18T00:00:00Z")]);
    // Collection is read only for the destination the policies named.
    const collectedValues = db.$queryRaw.mock.calls[1].slice(1);
    expect(collectedValues).toEqual(
      expect.arrayContaining(["mainnet", xlmSac, [DESTINATION]]),
    );
  });

  it("feeReport reads no policies and no transfers for an empty range", async () => {
    const report = await feeReport("mainnet", "2026-10-17", "2026-10-17");
    expect(report.days).toEqual([]);
    expect(db.feePolicy.findMany).not.toHaveBeenCalled();
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
