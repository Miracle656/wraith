import { fetchEventsSafe, getLatestLedger, type RawEvent } from "../../rpc";
import type { Network } from "../../network";

export interface EventSource {
  name: string;
  isHealthy(): Promise<boolean>;
  getLatestLedger(): Promise<number>;
  fetchEvents(
    startLedger: number,
    endLedger: number,
    contractIds: string[],
    limit?: number
  ): Promise<{ events: RawEvent[]; highestLedger: number }>;
}

/**
 * @param network Which chain this source reads. Omitted means the configured
 *   network, which is what every single-network deployment gets.
 */
export function createRpcSource(network?: Network): EventSource {
  return {
    name: "rpc",
    async isHealthy() {
      try {
        await getLatestLedger(network);
        return true;
      } catch {
        return false;
      }
    },
    getLatestLedger: () => getLatestLedger(network),
    fetchEvents(startLedger, endLedger, contractIds, limit) {
      return fetchEventsSafe(startLedger, endLedger, contractIds, limit, undefined, network);
    },
  };
}