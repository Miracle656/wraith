import type { RawEvent } from "../../rpc";
import { createHorizonSource, type FetchLike, type HorizonSourceConfig } from "./horizon";
import { createRpcSource, type EventSource } from "./rpc";

export type SourceSwitcherConfig = {
  horizonUrl?: string;
  horizonEventsPath?: string;
  fetchImpl: FetchLike;
};

export interface SourceSwitcher {
  getLatestLedger(): Promise<number>;
  fetchEvents(
    startLedger: number,
    endLedger: number,
    contractIds: string[],
    limit?: number
  ): Promise<{ events: RawEvent[]; highestLedger: number }>;
  getActiveSourceName(): Promise<string>;
}

function isTruthySource(source: EventSource | null): source is EventSource {
  return source !== null;
}

export function createSourceSwitcherWithConfig(config: SourceSwitcherConfig): SourceSwitcher {
  const sources = [
    createRpcSource(),
    config.horizonUrl
      ? createHorizonSource({
          baseUrl: config.horizonUrl.replace(/\/$/, ""),
          eventPath: config.horizonEventsPath ?? "/events",
          fetchImpl: config.fetchImpl,
        } satisfies HorizonSourceConfig)
      : null,
  ].filter(isTruthySource);
  if (sources.length === 0) {
    throw new Error("[indexer] No event sources configured.");
  }

  let preferred = sources[0];

  const pickHealthySource = async (): Promise<EventSource> => {
    if (await preferred.isHealthy()) return preferred;

    for (const source of sources) {
      if (await source.isHealthy()) {
        preferred = source;
        return source;
      }
    }

    throw new Error("[indexer] No healthy indexing source available.");
  };

  return {
    async getLatestLedger() {
      return (await pickHealthySource()).getLatestLedger();
    },
    async fetchEvents(startLedger, endLedger, contractIds, limit) {
      const source = await pickHealthySource();
      try {
        return await source.fetchEvents(startLedger, endLedger, contractIds, limit);
      } catch (error) {
        for (const fallback of sources) {
          if (fallback.name === source.name) continue;
          if (!(await fallback.isHealthy())) continue;

          preferred = fallback;
          return fallback.fetchEvents(startLedger, endLedger, contractIds, limit);
        }

        throw error;
      }
    },
    async getActiveSourceName() {
      return (await pickHealthySource()).name;
    },
  };
}

export function createSourceSwitcher(config: SourceSwitcherConfig): SourceSwitcher {
  return createSourceSwitcherWithConfig(config);
}