import type { RawEvent } from "../../rpc";
import type { EventSource } from "./rpc";

export type FetchLike = (input: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export type HorizonSourceConfig = {
  baseUrl: string;
  eventPath: string;
  fetchImpl: FetchLike;
};

type HorizonEventPayload = {
  id?: string;
  paging_token?: string;
  ledger?: number;
  ledger_sequence?: number;
  ledgerClosedAt?: string;
  ledger_close_time?: string;
  contractId?: string;
  contract_id?: string;
  txHash?: string;
  tx_hash?: string;
  topic?: unknown[];
  topics?: unknown[];
  value?: unknown;
};

function resolveBaseUrl(): string {
  throw new Error("[indexer] Horizon source configuration missing.");
}

function buildUrl(baseUrl: string, path: string, params: Record<string, string>): string {
  const query = Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return `${baseUrl}${path}${query ? `?${query}` : ""}`;
}

function normalizeEvent(raw: HorizonEventPayload): RawEvent {
  return {
    id: raw.id ?? raw.paging_token ?? "",
    type: "contract",
    ledger: raw.ledger ?? raw.ledger_sequence ?? 0,
    ledgerClosedAt: raw.ledgerClosedAt ?? raw.ledger_close_time ?? new Date().toISOString(),
    contractId: raw.contractId ?? raw.contract_id ?? "",
    txHash: raw.txHash ?? raw.tx_hash ?? "",
    topic: (raw.topic ?? raw.topics ?? []) as RawEvent["topic"],
    value: raw.value as RawEvent["value"],
  };
}

async function fetchJson<T>(url: string, fetchImpl: FetchLike): Promise<T> {
  if (!fetchImpl) {
    throw new Error("[indexer] Global fetch is unavailable.");
  }

  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`[indexer] Horizon request failed with ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function createHorizonSource(config: HorizonSourceConfig): EventSource {
  const { baseUrl, eventPath, fetchImpl } = config;

  return {
    name: "horizon",
    async isHealthy() {
      try {
        await this.getLatestLedger();
        return true;
      } catch {
        return false;
      }
    },
    async getLatestLedger() {
      const url = buildUrl(baseUrl, "/ledgers", { order: "desc", limit: "1" });

      const payload = await fetchJson<{ _embedded?: { records?: Array<{ sequence?: number }> } }>(url, fetchImpl);
      const latest = payload._embedded?.records?.[0]?.sequence;
      if (typeof latest !== "number") {
        throw new Error("[indexer] Horizon ledger tip unavailable.");
      }
      return latest;
    },
    async fetchEvents(startLedger, endLedger, contractIds, limit = 10_000) {
      const url = buildUrl(baseUrl, eventPath, {
        start_ledger: String(startLedger),
        end_ledger: String(endLedger),
        limit: String(limit),
      });
      if (contractIds.length > 0) {
        // Append rather than rebuild to keep the helper simple.
        const contracted = `${url}${url.includes("?") ? "&" : "?"}contract_ids=${encodeURIComponent(contractIds.join(","))}`;
        return fetchJson<{ records?: HorizonEventPayload[]; _embedded?: { records?: HorizonEventPayload[] } }>(contracted, fetchImpl).then((payload) => {
          const records = payload.records ?? payload._embedded?.records ?? [];
          const events = records.map(normalizeEvent).filter((event) => event.id && event.contractId);
          const highestLedger = events.reduce((max, event) => Math.max(max, event.ledger), startLedger);

          return { events, highestLedger };
        });
      }

      const payload = await fetchJson<{ records?: HorizonEventPayload[]; _embedded?: { records?: HorizonEventPayload[] } }>(url, fetchImpl);
      const records = payload.records ?? payload._embedded?.records ?? [];
      const events = records.map(normalizeEvent).filter((event) => event.id && event.contractId);
      const highestLedger = events.reduce((max, event) => Math.max(max, event.ledger), startLedger);

      return { events, highestLedger };
    },
  };
}