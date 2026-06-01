import crypto from "crypto";
import { prisma } from "../db";
import { transferEmitter } from "../events";
import type { TransferEvent } from "../events";

// ─── Config ───────────────────────────────────────────────────────────────────
const MAX_ATTEMPTS = 5;

/**
 * Exponential backoff delays (seconds) indexed by attempt number (1-based).
 * Attempt 1 = immediate, 2 = 30s, 3 = 5min, 4 = 30min, 5 = 2h
 */
const BACKOFF_SECONDS = [0, 30, 300, 1800, 7200];

// How often the retry loop scans for due deliveries (ms)
const RETRY_POLL_MS = 15_000;

// ─── Types ────────────────────────────────────────────────────────────────────
interface WebhookFilter {
  contract?:   string;
  from?:       string;
  to?:         string;
  min_amount?: string; // decimal string — compared as BigInt
}

// ─── HMAC signing ─────────────────────────────────────────────────────────────
/**
 * Sign a JSON string with the subscription's secret.
 * Produces the value for the X-Wraith-Signature header.
 */
export function signPayload(secret: string, body: string): string {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(body);
  return "sha256=" + hmac.digest("hex");
}

// ─── Filter evaluation ────────────────────────────────────────────────────────
/**
 * Returns true when a transfer matches the subscription's filter.
 * A null/empty filter matches everything.
 */
export function matchesFilter(
  transfer: TransferEvent,
  filter: WebhookFilter | null | undefined
): boolean {
  if (!filter) return true;
  if (filter.contract   && transfer.contractId   !== filter.contract)   return false;
  if (filter.from       && transfer.fromAddress  !== filter.from)       return false;
  if (filter.to         && transfer.toAddress    !== filter.to)         return false;
  if (filter.min_amount && BigInt(transfer.amount) < BigInt(filter.min_amount)) return false;
  return true;
}

// ─── Single delivery attempt ──────────────────────────────────────────────────
/**
 * POST the payload to the subscriber's URL and update the delivery row.
 * Schedules a retry if the attempt fails and attempts < MAX_ATTEMPTS.
 */
async function attemptDelivery(deliveryId: number): Promise<void> {
  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { subscription: true },
  });

  if (!delivery || !delivery.subscription.active) return;
  if (delivery.status === "success") return;

  const body    = JSON.stringify(delivery.payload);
  const sig     = signPayload(delivery.subscription.secret, body);
  const attempt = delivery.attempts + 1;

  let statusCode: number | null = null;
  let error: string | null      = null;
  let success                   = false;

  try {
    const res = await fetch(delivery.subscription.url, {
      method:  "POST",
      headers: {
        "Content-Type":       "application/json",
        "X-Wraith-Signature": sig,
        "X-Wraith-Delivery":  String(delivery.id),
      },
      body,
      signal: AbortSignal.timeout(10_000), // 10-second timeout
    });

    statusCode = res.status;
    success    = res.ok;
  } catch (err) {
    error = (err as Error).message;
  }

  const now = new Date();

  if (success) {
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status:         "success",
        attempts:       attempt,
        lastStatusCode: statusCode,
        lastError:      null,
        nextRetryAt:    null,
        deliveredAt:    now,
      },
    });
    return;
  }

  // Failed — schedule retry or mark permanently failed
  const canRetry     = attempt < MAX_ATTEMPTS;
  const delaySecs    = canRetry ? BACKOFF_SECONDS[attempt] ?? 7200 : 0;
  const nextRetryAt  = canRetry ? new Date(now.getTime() + delaySecs * 1000) : null;

  await prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      status:         canRetry ? "pending" : "failed",
      attempts:       attempt,
      lastStatusCode: statusCode,
      lastError:      error ?? `HTTP ${statusCode}`,
      nextRetryAt,
    },
  });

  if (!canRetry) {
    console.warn(
      `[webhooks] Delivery ${deliveryId} permanently failed after ${attempt} attempts`
    );
  }
}

// ─── Enqueue deliveries for a new transfer ────────────────────────────────────
/**
 * Called on every new transfer. Finds matching active subscriptions and
 * creates WebhookDelivery rows, then fires the first attempt immediately.
 */
async function enqueueDeliveries(transfer: TransferEvent): Promise<void> {
  const subscriptions = await prisma.webhookSubscription.findMany({
    where: { active: true },
  });

  for (const sub of subscriptions) {
    const filter = sub.filter as WebhookFilter | null;
    if (!matchesFilter(transfer, filter)) continue;

    const payload = {
      id:             transfer.eventId,
      contractId:     transfer.contractId,
      eventType:      transfer.eventType,
      fromAddress:    transfer.fromAddress,
      toAddress:      transfer.toAddress,
      amount:         transfer.amount,
      ledger:         transfer.ledger,
      ledgerClosedAt: transfer.ledgerClosedAt,
      txHash:         transfer.txHash,
    };

    const delivery = await prisma.webhookDelivery.create({
      data: {
        subscriptionId: sub.id,
        eventId:        transfer.eventId,
        payload,
        status:         "pending",
        nextRetryAt:    new Date(),
      },
    });

    // Fire immediately — don't await so we don't block the indexer
    attemptDelivery(delivery.id).catch((e) =>
      console.error(`[webhooks] Delivery ${delivery.id} error:`, e)
    );
  }
}

// ─── Retry loop ───────────────────────────────────────────────────────────────
/**
 * Polls the DB for pending deliveries whose nextRetryAt has passed and
 * reattempts them. Runs every RETRY_POLL_MS milliseconds.
 */
async function retryLoop(): Promise<void> {
  while (true) {
    await new Promise((r) => setTimeout(r, RETRY_POLL_MS));

    try {
      const due = await prisma.webhookDelivery.findMany({
        where: {
          status:      "pending",
          nextRetryAt: { lte: new Date() },
          attempts:    { gt: 0 }, // attempts=0 rows are handled by enqueueDeliveries
        },
        take: 50,
        orderBy: { nextRetryAt: "asc" },
      });

      for (const delivery of due) {
        attemptDelivery(delivery.id).catch((e) =>
          console.error(`[webhooks] Retry ${delivery.id} error:`, e)
        );
      }
    } catch (err) {
      console.error("[webhooks] Retry loop error:", err);
    }
  }
}

// ─── Start webhook worker ─────────────────────────────────────────────────────
/**
 * Wire up the transfer emitter listener and start the retry loop.
 * Call once at application startup (from index.ts).
 */
export function startWebhookWorker(): void {
  transferEmitter.on("transfer:new", (transfer: TransferEvent) => {
    enqueueDeliveries(transfer).catch((e) =>
      console.error("[webhooks] Enqueue error:", e)
    );
  });

  retryLoop().catch((e) =>
    console.error("[webhooks] Retry loop crashed:", e)
  );

  console.log("[webhooks] Worker started — listening for transfers");
}
