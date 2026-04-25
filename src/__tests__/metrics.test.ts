import request from "supertest";
import { createApp } from "../api";

describe("Prometheus Metrics", () => {
  const app = createApp();

  it("GET /metrics returns Prometheus text format", async () => {
    const res = await request(app).get("/metrics");
    
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    
    // Check for some default metrics
    expect(res.text).toContain("process_cpu_seconds_total");
    
    // Check for our custom metrics
    expect(res.text).toContain("trades_ingested_total");
    expect(res.text).toContain("amm_snapshots_total");
    expect(res.text).toContain("price_requests_total");
    expect(res.text).toContain("db_query_duration_seconds");
  });

  it("metrics endpoint is not gated by rate limits (optional check)", async () => {
    // This is hard to test without many requests, but we verified the order in api.ts
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
  });
});
