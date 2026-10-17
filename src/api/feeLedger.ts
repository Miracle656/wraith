/**
 * The platform fee ledger: what `GET /fees` quoted, under which policy.
 *
 * ## Why this exists
 *
 * The fee is collected on-chain, in the same transaction as the user's own
 * payment, and the money never passes through wraith. So until this, nothing on
 * this side knew it had happened: there was no answer to how much had been
 * charged, in which asset, on which day, and nothing tied a payment on the
 * treasury account to the request that priced it. And because the fee is now
 * policy — percent, floor and cap — rather than a constant, a misconfiguration
 * would overcharge every user until somebody read a block explorer.
 *
 * ## What is recorded, and what deliberately is not
 *
 * One row per asset per quote: the amount priced against, the asset, the fee
 * returned, the rule that decided it, and the policy that was in force. The
 * policy is taken from the very entry the client was sent — never by reading
 * the environment a second time — so the record cannot disagree with what the
 * user was told.
 *
 * **Nothing recorded identifies a person.** No IP, no user agent, no sender or
 * wallet address. The only address anywhere in here is the fee destination,
 * which `/fees` publishes to anyone. Do not add a column that changes that:
 * the amount and the time of a quote are not personal data on their own, but
 * either joined to a requester would be.
 *
 * ## Failure
 *
 * Recording never throws and is never awaited by the response. The person is
 * in the middle of a payment; a ledger outage must not become a failed send.
 * A write that fails is logged and counted in
 * `veil_fee_quote_record_failures_total`, so a gap is visible rather than a
 * quietly low total.
 */

import { createHash } from "crypto";
import { Asset, Networks } from "@stellar/stellar-sdk";

import { prisma } from "../db";
import { toDisplayAmount } from "../amount";
import { resolveSacContractIds } from "../indexer";
import { feeQuoteAlarmsTotal, feeQuoteRecordFailuresTotal } from "../metrics";
import type { Network } from "../network";
import type { FeeBasis, PlatformFee } from "./fees";

// ─── Policy ──────────────────────────────────────────────────────────────────

/** Everything that decides a fee for one asset, and nothing about who asked. */
export interface FeePolicyShape {
  mode: "flat" | "percent";
  assetCode: string;
  assetIssuer: string | null;
  destination: string;
  /** Percent mode only. */
  percent: string | null;
  min: string | null;
  max: string | null;
  /** Flat mode only: the fixed fee. */
  amount: string | null;
}

/**
 * The policy behind one `/fees` entry.
 *
 * In percent mode `amount` is the *result* for this quote, not policy, so it is
 * left out; otherwise every distinct amount would look like a policy change.
 */
export function policyOf(fee: PlatformFee): FeePolicyShape {
  const percentMode = fee.percent !== undefined;
  return {
    mode: percentMode ? "percent" : "flat",
    assetCode: fee.assetCode,
    assetIssuer: fee.assetIssuer,
    destination: fee.destination,
    percent: percentMode ? fee.percent! : null,
    min: percentMode ? (fee.min ?? null) : null,
    max: percentMode ? (fee.max ?? null) : null,
    amount: percentMode ? null : fee.amount,
  };
}

/**
 * A stable id for a policy: the same configuration always hashes the same,
 * any change to it does not. Keys are written in a fixed order so the id does
 * not depend on how the object happened to be built.
 */
export function policyId(policy: FeePolicyShape): string {
  const canonical = JSON.stringify([
    policy.mode,
    policy.assetCode,
    policy.assetIssuer,
    policy.destination,
    policy.percent,
    policy.min,
    policy.max,
    policy.amount,
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

// ─── Alarm ───────────────────────────────────────────────────────────────────

/**
 * The default ceiling: a fee above 10% of what it was quoted against.
 *
 * The fee policy's own rationale calls 10% of a send "stark" — it is the
 * number that made the flat fee indefensible. A sane percent is well under a
 * tenth of that, so crossing it means either a floor on a very small send or
 * a misconfigured policy. Both are worth a human looking.
 */
export const DEFAULT_ALARM_PERCENT = 10;

/** `VEIL_FEE_ALARM_PERCENT`, or the default when unset or not a sane number. */
export function alarmPercent(): number {
  const raw = Number(process.env.VEIL_FEE_ALARM_PERCENT?.trim() || NaN);
  return Number.isFinite(raw) && raw > 0 && raw <= 100 ? raw : DEFAULT_ALARM_PERCENT;
}

// ─── Recording ───────────────────────────────────────────────────────────────

export interface QuotedFee {
  fee: PlatformFee;
  basis: FeeBasis;
}

const DP = 7;

/** A positive decimal, at Stellar's seven places, trailing zeros removed. */
function decimal(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  // toFixed switches to exponent notation from 1e21 on; such an amount is not
  // sendable anyway, but the record should still say what was asked.
  if (Math.abs(value) >= 1e21) return String(value);
  return value.toFixed(DP).replace(/0+$/, "").replace(/\.$/, "") || "0";
}

/** Strip trailing zeros from a decimal string that Postgres returned. */
function trimDecimal(value: string): string {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}

/** The row this quote becomes, before anything is written. */
export function quoteRow(
  network: Network,
  sent: number | undefined,
  { fee, basis }: QuotedFee,
  limitPercent = alarmPercent(),
) {
  const policy = policyOf(fee);
  const charged = Number(fee.amount);
  const percentOfAmount = sent !== undefined && sent > 0 ? (charged / sent) * 100 : null;
  return {
    policy,
    data: {
      network,
      assetCode: fee.assetCode,
      assetIssuer: fee.assetIssuer,
      quotedAgainst: sent !== undefined ? decimal(sent) : null,
      fee: fee.amount,
      basis,
      feePercent: percentOfAmount !== null ? decimal(percentOfAmount) : null,
      alarm: percentOfAmount !== null && percentOfAmount > limitPercent,
      policyId: policyId(policy),
    },
  };
}

/**
 * Policies already written by this process, so a steady stream of quotes
 * under one configuration does not re-insert the same row every time.
 */
const knownPolicies = new Set<string>();

/** Test-only. */
export function _forgetKnownPolicies(): void {
  knownPolicies.clear();
}

/**
 * Write every fee in one `/fees` answer to the ledger.
 *
 * Never throws — see the module header. The alarm is raised before the write,
 * so a database outage cannot also silence an overcharge.
 */
export async function recordFeeQuotes(
  network: Network,
  sent: number | undefined,
  quoted: QuotedFee[],
): Promise<void> {
  if (quoted.length === 0) return;
  try {
    const limit = alarmPercent();
    const rows = quoted.map((q) => quoteRow(network, sent, q, limit));

    for (const { data } of rows) {
      if (!data.alarm) continue;
      feeQuoteAlarmsTotal.inc({ network, asset: data.assetCode });
      // Amount, fee and policy only — none of it identifies anyone.
      console.error(
        `[fees] ALARM ${network} ${data.assetCode}: fee ${data.fee} is ${data.feePercent}% of ` +
          `${data.quotedAgainst}, over the ${limit}% limit (policy ${data.policyId}, basis ${data.basis})`,
      );
    }

    const newPolicies = new Map<string, FeePolicyShape>();
    for (const { policy, data } of rows) {
      if (!knownPolicies.has(data.policyId)) newPolicies.set(data.policyId, policy);
    }
    if (newPolicies.size > 0) {
      // skipDuplicates: two instances seeing a new policy at once is a race we
      // expect, and the first writer's `firstSeenAt` is the true one.
      await prisma.feePolicy.createMany({
        data: [...newPolicies].map(([id, policy]) => ({ id, policy: { ...policy } })),
        skipDuplicates: true,
      });
      for (const id of newPolicies.keys()) knownPolicies.add(id);
    }

    await prisma.feeQuote.createMany({ data: rows.map((r) => r.data) });
  } catch (err) {
    feeQuoteRecordFailuresTotal.inc({ network });
    console.error(
      `[fees] could not record ${quoted.length} fee quote(s): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─── Reporting ───────────────────────────────────────────────────────────────

interface QuotedDayRow {
  day: string;
  assetCode: string;
  assetIssuer: string | null;
  quotes: number;
  feesQuoted: string;
  alarms: number;
  policyIds: string[];
}

export interface FeeReportAsset {
  assetCode: string;
  assetIssuer: string | null;
  /** Quotes that returned a fee in this asset. */
  quotes: number;
  /** The sum of every fee quoted — what clients were told to charge. */
  feesQuoted: string;
  /** Quotes over the alarm limit. */
  alarms: number;
  /** The policies that priced them. Look each up in `policies`. */
  policyIds: string[];
  /**
   * What the fee destination actually received in this asset that day,
   * according to the index — or null when this asset is not indexed, which is
   * not the same thing as zero.
   */
  collected: string | null;
  collectedNote?: string;
}

export interface FeeReport {
  network: Network;
  from: string;
  to: string;
  alarmPercent: number;
  days: Array<{ date: string; assets: FeeReportAsset[] }>;
  policies: Record<string, { firstSeenAt: string; policy: FeePolicyShape }>;
}

/** The asset's Stellar Asset Contract id on `network`, or null if it has none. */
function sacId(network: Network, code: string, issuer: string | null): string | null {
  try {
    const asset = issuer ? new Asset(code, issuer) : Asset.native();
    return asset.contractId(network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET);
  } catch {
    return null;
  }
}

const assetKey = (code: string, issuer: string | null) => `${code}:${issuer ?? ""}`;

/**
 * What was charged on each day from `from` to `to` (inclusive, UTC dates),
 * per asset, and under which policies.
 *
 * "Collected" comes from the indexed transfers into the destinations those
 * policies named. It counts everything the destination received in that
 * asset, so it is a true collected total only while the destination is used
 * for fees alone — which is how it should be configured.
 */
export async function feeReport(network: Network, from: string, to: string): Promise<FeeReport> {
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 1);

  const quoted = await prisma.$queryRaw<QuotedDayRow[]>`
    SELECT to_char(date_trunc('day', "quotedAt"), 'YYYY-MM-DD') AS "day",
           "assetCode",
           "assetIssuer",
           count(*)::int AS "quotes",
           COALESCE(sum("fee"), 0)::text AS "feesQuoted",
           (count(*) FILTER (WHERE "alarm"))::int AS "alarms",
           array_agg(DISTINCT "policyId") AS "policyIds"
      FROM "wraith"."FeeQuote"
     WHERE "network" = ${network}
       AND "quotedAt" >= ${start}
       AND "quotedAt" < ${end}
     GROUP BY 1, 2, 3
     ORDER BY 1, 2, 3`;

  const ids = [...new Set(quoted.flatMap((r) => r.policyIds))];
  const policyRows = ids.length
    ? await prisma.feePolicy.findMany({ where: { id: { in: ids } } })
    : [];
  const policies: FeeReport["policies"] = {};
  for (const row of policyRows) {
    policies[row.id] = {
      firstSeenAt: row.firstSeenAt.toISOString(),
      policy: row.policy as unknown as FeePolicyShape,
    };
  }

  // Collected, per asset that was quoted in the range.
  const indexed = new Set(resolveSacContractIds(network));
  const collected = new Map<string, Map<string, string>>();
  const notes = new Map<string, string>();
  const assets = new Map<string, { code: string; issuer: string | null }>();
  for (const r of quoted) assets.set(assetKey(r.assetCode, r.assetIssuer), { code: r.assetCode, issuer: r.assetIssuer });

  for (const [key, { code, issuer }] of assets) {
    const contractId = sacId(network, code, issuer);
    if (!contractId || !indexed.has(contractId)) {
      notes.set(key, "This asset's contract is not indexed by this deployment, so collection cannot be read.");
      continue;
    }
    const destinations = [
      ...new Set(
        quoted
          .filter((r) => assetKey(r.assetCode, r.assetIssuer) === key)
          .flatMap((r) => r.policyIds)
          .map((id) => policies[id]?.policy.destination)
          .filter((d): d is string => typeof d === "string"),
      ),
    ];
    if (destinations.length === 0) {
      notes.set(key, "The policies behind these quotes could not be read, so their destination is unknown.");
      continue;
    }
    const received = await prisma.$queryRaw<Array<{ day: string; total: string }>>`
      SELECT to_char(date_trunc('day', "ledgerClosedAt"), 'YYYY-MM-DD') AS "day",
             COALESCE(sum("amount"::numeric), 0)::text AS "total"
        FROM "wraith"."TokenTransfer"
       WHERE "network" = ${network}
         AND "contractId" = ${contractId}
         AND "eventType" = 'transfer'
         AND "toAddress" = ANY(${destinations})
         AND "ledgerClosedAt" >= ${start}
         AND "ledgerClosedAt" < ${end}
       GROUP BY 1`;
    const byDay = new Map<string, string>();
    for (const row of received) {
      // SAC amounts are integer stroops at seven decimals.
      byDay.set(row.day, trimDecimal(toDisplayAmount(row.total.split(".")[0], DP)));
    }
    collected.set(key, byDay);
  }

  // One entry per (day, asset): every quoted pair, plus any day the
  // destination received funds in a quoted asset without a quote that day.
  const days = new Map<string, Map<string, FeeReportAsset>>();
  const slot = (day: string, code: string, issuer: string | null): FeeReportAsset => {
    if (!days.has(day)) days.set(day, new Map());
    const perDay = days.get(day)!;
    const key = assetKey(code, issuer);
    if (!perDay.has(key)) {
      const note = notes.get(key);
      perDay.set(key, {
        assetCode: code,
        assetIssuer: issuer,
        quotes: 0,
        feesQuoted: "0",
        alarms: 0,
        policyIds: [],
        collected: collected.has(key) ? (collected.get(key)!.get(day) ?? "0") : null,
        ...(note ? { collectedNote: note } : {}),
      });
    }
    return perDay.get(key)!;
  };

  for (const r of quoted) {
    const entry = slot(r.day, r.assetCode, r.assetIssuer);
    entry.quotes = r.quotes;
    entry.feesQuoted = trimDecimal(r.feesQuoted);
    entry.alarms = r.alarms;
    entry.policyIds = [...r.policyIds].sort();
  }
  for (const [key, byDay] of collected) {
    const { code, issuer } = assets.get(key)!;
    for (const day of byDay.keys()) slot(day, code, issuer);
  }

  return {
    network,
    from,
    to,
    alarmPercent: alarmPercent(),
    days: [...days.keys()].sort().map((date) => ({
      date,
      assets: [...days.get(date)!.values()].sort((a, b) =>
        assetKey(a.assetCode, a.assetIssuer).localeCompare(assetKey(b.assetCode, b.assetIssuer)),
      ),
    })),
    policies,
  };
}
