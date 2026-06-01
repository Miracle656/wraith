import { fetchEventsSafe, getLatestLedger, type RawEvent } from "../../rpc";

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

export function createRpcSource(): EventSource {
  return {
    name: "rpc",
    async isHealthy() {
      try {
        await getLatestLedger();
        return true;
      } catch {
        return false;
      }
    },
    getLatestLedger,
    fetchEvents(startLedger, endLedger, contractIds, limit) {
      return fetchEventsSafe(startLedger, endLedger, contractIds, limit);
    },
  };
}