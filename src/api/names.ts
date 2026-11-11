/**
 * Veil Names, over HTTP.
 *
 * `src/names/pricing.ts` and `src/names/term.ts` hold the rules — what a name
 * may be, what it costs, how a term and its expiry work. They had no route, so
 * nothing could reach them: the wallet's `/names` page calls
 * `GET {WRAITH_URL}/names/{name}` and got a 404 from a server that already
 * knew the answer.
 *
 * ## What this can and cannot answer today
 *
 * The registry is `contracts/veil-names` in the veil repo, and it is not
 * deployed. So the questions split:
 *
 * - **Answerable from these rules alone.** Is this a name at all? Is it
 *   reserved? What would it cost for a term? None of that needs a ledger, and
 *   all of it is wrong to compute on the client alone — a client that prices a
 *   name differently quotes a total nobody agreed to.
 * - **Needs the chain.** Is it taken, and by whom. Until the registry exists
 *   this returns 503 rather than guessing, because "available" is the one
 *   answer that would cost somebody money if it were wrong.
 *
 * The wallet already treats a non-OK reply as "cannot tell" and renders *Not
 * live yet* rather than offering a claim, so a 503 is handled end to end
 * today. That is deliberate on both sides: a 404 that reads as "nobody has it"
 * is how a page comes to sell a name it cannot deliver.
 */

import { Router, type Request, type Response } from "express";

import { sendError } from "./errors";
import {
  MAX_NAME_LENGTH,
  MIN_SELLABLE_LENGTH,
  NAME_PRICE_BANDS,
  NFT_PRICE_USDC,
  LONG_NAME_MIN_LENGTH,
  LONG_NAME_PRICE_USDC,
  checkName,
  isReserved,
  normalizeName,
  priceRegistration,
} from "../names/pricing";
import {
  MAX_TERM_YEARS,
  MIN_TERM_YEARS,
  RECOVERY_WINDOW_DAYS,
  RENEWAL_REMINDER_DAYS,
} from "../names/term";

/**
 * Whether a deployed registry is configured for this process.
 *
 * Read per request rather than captured at import, so a deploy that sets the
 * variable takes effect without a rebuild — and so tests can set it.
 *
 * No default: a placeholder contract id would make every answer below sound
 * authoritative about a contract that does not exist.
 */
function registryContractId(): string | null {
  const id = process.env.VEIL_NAMES_CONTRACT_ID?.trim();
  return id && id.length > 0 ? id : null;
}

/**
 * The `:name` path segment as a single string.
 *
 * Express types a route param as `string | string[]`, and an array means the
 * request carried the segment more than once. There is no sensible way to
 * price two names at the same time, so the empty string is returned and
 * `checkName` rejects it as `empty` — a 400, rather than a silent pick of one.
 */
function pathName(raw: string | string[] | undefined): string {
  return typeof raw === "string" ? raw : "";
}

/** HTTP status for a rejected candidate. */
function statusForRejection(reason: string): number {
  // `reserved` is a decision about a valid name, not a malformed request —
  // the caller asked a well-formed question and the answer is no.
  return reason === "reserved" ? 200 : 400;
}

export function namesRouter(): Router {
  const router = Router();

  /**
   * The price table and the rules behind it.
   *
   * Registered before `/:name` so it cannot be shadowed. A name could never
   * collide with it anyway — `price-table` contains a hyphen, and the charset
   * is `[a-z0-9_]` — but relying on that to hold forever is how a route goes
   * missing after an unrelated change.
   */
  router.get("/price-table", (_req: Request, res: Response) => {
    res.json({
      // The middle band is dearest on purpose: real first names are six to ten
      // characters and that is where the demand is. It prices demand, not
      // scarcity, and is not a mistake to "correct" into a descending curve.
      bands: [
        ...NAME_PRICE_BANDS.map((band, i) => ({
          minLength: i === 0 ? MIN_SELLABLE_LENGTH : NAME_PRICE_BANDS[i - 1].maxLength + 1,
          maxLength: band.maxLength,
          perYearUsdc: band.priceUsdc,
        })),
        {
          minLength: LONG_NAME_MIN_LENGTH,
          maxLength: MAX_NAME_LENGTH,
          perYearUsdc: LONG_NAME_PRICE_USDC,
        },
      ],
      term: {
        minYears: MIN_TERM_YEARS,
        maxYears: MAX_TERM_YEARS,
        recoveryWindowDays: RECOVERY_WINDOW_DAYS,
        renewalReminderDays: RENEWAL_REMINDER_DAYS,
      },
      figure: { priceUsdc: NFT_PRICE_USDC },
      /** False until the registry contract is deployed; names cannot be bought. */
      registryLive: registryContractId() !== null,
    });
  });

  /**
   * What a registration would cost.
   *
   * `priceRegistration` validates the term rather than trusting it, and is the
   * only place a total is computed — a caller that multiplies a per-year price
   * by its own term is a caller that can get the term wrong.
   */
  router.get("/:name/quote", (req: Request, res: Response) => {
    const years = Number(req.query.years ?? MIN_TERM_YEARS);
    if (!Number.isFinite(years)) {
      sendError(res, 400, "bad_term", "years must be a number");
      return;
    }

    const priced = priceRegistration(pathName(req.params.name), years);
    if (!priced.ok) {
      sendError(res, statusForRejection(priced.reason), priced.reason, `Cannot price this name: ${priced.reason}`);
      return;
    }

    res.json({ ...priced.registration, registryLive: registryContractId() !== null });
  });

  /**
   * Whether a name can be had.
   *
   * The reply shape is the wallet's `Availability`: `available`, `taken`,
   * `yours`, `reserved`, or a non-OK status the client reads as "cannot tell".
   */
  router.get("/:name", (req: Request, res: Response) => {
    const candidate = pathName(req.params.name);

    const check = checkName(candidate);
    if (!check.ok) {
      if (check.reason === "reserved") {
        // Answerable without the chain, and worth answering: a reserved name
        // must never be offered, or somebody poses as Veil or its team.
        res.json({ name: normalizeName(candidate), status: "reserved", reason: "reserved" });
        return;
      }
      sendError(res, 400, check.reason, `Not a usable name: ${check.reason}`);
      return;
    }

    const contractId = registryContractId();
    if (!contractId) {
      // 503, not 404. The distinction is the whole point: 404 reads as
      // "nobody has this name", which is exactly the false "available" that
      // would let the page sell something it cannot deliver.
      res.status(503).json({
        name: check.name,
        status: "unknown",
        priceUsdc: check.priceUsdc,
        detail:
          "The Veil Names registry contract is not deployed, so whether this name is taken cannot be determined.",
      });
      return;
    }

    // Reaching here means a registry is configured, and reading it is the next
    // piece of work: `resolve(name)` and `state(name)` off the contract give
    // taken/open directly, and `yours` needs the caller's wallet address,
    // which this route does not yet take.
    res.status(503).json({
      name: check.name,
      status: "unknown",
      priceUsdc: check.priceUsdc,
      detail: "Registry lookups are not implemented yet.",
    });
  });

  return router;
}

/** Exported for the route tests, which assert the reserved answer directly. */
export const __test = { isReserved, statusForRejection };
