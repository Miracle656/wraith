/**
 * The Veil Names HTTP surface.
 *
 * `src/names/pricing.ts` and `src/names/term.ts` already have their own unit
 * tests; these pin what reaches a caller over HTTP, and in particular the one
 * thing that must never regress: with no registry deployed, a name is **not**
 * reported available. The wallet's `/names` page reads any non-OK reply as
 * "cannot tell" and refuses to offer a claim, so a 200 saying "available"
 * here is how the page would come to sell a name nobody can deliver.
 */
import express from "express";
import request from "supertest";

import { namesRouter } from "../../api/names";

function app() {
  const a = express();
  a.use("/names", namesRouter());
  return a;
}

const SAVED = { ...process.env };

afterEach(() => {
  process.env = { ...SAVED };
});

describe("GET /names/:name", () => {
  it("does not say a valid name is available while the registry is undeployed", async () => {
    delete process.env.VEIL_NAMES_CONTRACT_ID;

    const res = await request(app()).get("/names/adebayo");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("unknown");
    expect(res.body.status).not.toBe("available");
  });

  it("still prices the name it cannot resolve, so the page can show a cost", async () => {
    delete process.env.VEIL_NAMES_CONTRACT_ID;

    const res = await request(app()).get("/names/adebayo");

    // Seven characters — the middle band, which is the dearest on purpose.
    expect(res.body.priceUsdc).toBe(5);
    expect(res.body.name).toBe("adebayo");
  });

  it("answers reserved without needing the chain", async () => {
    // A reserved name must never be offered, or somebody poses as Veil or its
    // team — and that is answerable from the rules alone.
    const res = await request(app()).get("/names/admin");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("reserved");
  });

  it("normalizes case before answering", async () => {
    const res = await request(app()).get("/names/Adebayo");
    expect(res.body.name).toBe("adebayo");
  });

  it("400s a name the registry could never hold, with the reason", async () => {
    const cases: [string, string][] = [
      ["ab", "too_short"],
      ["a".repeat(21), "too_long"],
      ["ade-bayo", "bad_charset"],
      ["_adebayo", "bad_separator"],
    ];

    for (const [candidate, reason] of cases) {
      const res = await request(app()).get(`/names/${candidate}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(reason);
    }
  });

  it("refuses a Cyrillic homoglyph rather than folding it to ASCII", async () => {
    // jаck — the second character is Cyrillic "а". Folding it would let
    // one name resolve to another holder's payment destination.
    const res = await request(app()).get(`/names/${encodeURIComponent("jаck")}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("bad_charset");
  });

  it("reports the registry as configured once a contract id is set", async () => {
    process.env.VEIL_NAMES_CONTRACT_ID = "CSOMECONTRACT";

    // Still 503 — lookups are not implemented — but the reason has moved on
    // from "there is no registry", which is what the next piece of work closes.
    const res = await request(app()).get("/names/adebayo");
    expect(res.status).toBe(503);
    expect(res.body.detail).toMatch(/not implemented/i);
  });
});

describe("GET /names/:name/quote", () => {
  it("multiplies the band by the term in one place", async () => {
    const res = await request(app()).get("/names/adebayo/quote?years=3");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: "adebayo",
      years: 3,
      perYearUsdc: 5,
      totalUsdc: 15,
    });
  });

  it("prices the bands as designed, middle dearest", async () => {
    const short = await request(app()).get("/names/ada/quote?years=1");
    const middle = await request(app()).get("/names/adebayo/quote?years=1");
    const long = await request(app()).get("/names/adebayoakinola/quote?years=1");

    expect(short.body.perYearUsdc).toBe(3);
    expect(middle.body.perYearUsdc).toBe(5);
    expect(long.body.perYearUsdc).toBe(2);

    // Not a mistake to "correct" into a descending curve: it prices demand,
    // and real first names are six to ten characters.
    expect(middle.body.perYearUsdc).toBeGreaterThan(short.body.perYearUsdc);
    expect(middle.body.perYearUsdc).toBeGreaterThan(long.body.perYearUsdc);
  });

  it("defaults to the minimum term rather than guessing a longer one", async () => {
    const res = await request(app()).get("/names/adebayo/quote");

    expect(res.body.years).toBe(1);
    expect(res.body.totalUsdc).toBe(5);
  });

  it("refuses a term outside one to five years", async () => {
    for (const years of [0, 6, -1]) {
      const res = await request(app()).get(`/names/adebayo/quote?years=${years}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("bad_term");
    }
  });

  it("refuses a term that is not a number", async () => {
    const res = await request(app()).get("/names/adebayo/quote?years=many");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("bad_term");
  });

  it("refuses to quote a name that cannot be registered", async () => {
    const res = await request(app()).get("/names/ab/quote?years=1");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("too_short");
  });
});

describe("GET /names/price-table", () => {
  it("is not shadowed by the :name route", async () => {
    const res = await request(app()).get("/names/price-table");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.bands)).toBe(true);
  });

  it("publishes contiguous bands covering 3 to 20 characters", async () => {
    const { bands } = (await request(app()).get("/names/price-table")).body;

    expect(bands[0].minLength).toBe(3);
    expect(bands[bands.length - 1].maxLength).toBe(20);

    for (let i = 1; i < bands.length; i += 1) {
      // A gap here would be a length nobody can price, and an overlap would be
      // two prices for one name.
      expect(bands[i].minLength).toBe(bands[i - 1].maxLength + 1);
    }
  });

  it("publishes the term bounds and the recovery window", async () => {
    const { term } = (await request(app()).get("/names/price-table")).body;

    expect(term).toMatchObject({
      minYears: 1,
      maxYears: 5,
      recoveryWindowDays: 90,
    });
  });

  it("says plainly that the registry is not live", async () => {
    delete process.env.VEIL_NAMES_CONTRACT_ID;

    const res = await request(app()).get("/names/price-table");
    expect(res.body.registryLive).toBe(false);
  });
});
