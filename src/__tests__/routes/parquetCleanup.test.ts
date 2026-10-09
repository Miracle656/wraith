import express, { NextFunction, Request, Response } from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { finished } from "stream/promises";
import request from "supertest";

jest.mock("../../db", () => ({
  prisma: { tokenTransfer: { findMany: jest.fn() } },
  toDisplayAmount: (amount: string) => amount,
}));
jest.mock("../../tokenCache", () => ({ getCachedTokenDecimals: () => 7 }));

import { createExportsRouter } from "../../routes/exports";
import { prisma } from "../../db";

const parquet = require("parquetjs-lite");
const findMany = prisma.tokenTransfer.findMany as jest.Mock;
const createWriteStream = fs.createWriteStream.bind(fs);
let outputs: fs.WriteStream[];
let receivedError: unknown;

function app() {
  const server = express();
  server.use(createExportsRouter());
  server.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    receivedError = error;
    res.status(500).json({ error: "export failed" });
  });
  return server;
}

const transfer = {
  id: 1,
  contractId: "CEXAMPLE",
  eventType: "transfer",
  fromAddress: null,
  toAddress: "GEXAMPLE",
  amount: "10000000",
  ledger: 123,
  ledgerClosedAt: new Date("2026-01-01T00:00:00Z"),
  txHash: "hash-1",
  eventId: "event-1",
  isSac: false,
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

beforeEach(() => {
  findMany.mockReset();
  outputs = [];
  receivedError = undefined;
  jest.spyOn(fs, "createWriteStream").mockImplementation((file, options) => {
    const stream = createWriteStream(file, options);
    if (String(file).startsWith(path.join(os.tmpdir(), "transfers-"))) outputs.push(stream);
    return stream;
  });
});

afterEach(async () => {
  jest.restoreAllMocks();
  // Also release descriptors when a regression fails against the old handler.
  for (const output of outputs) {
    output.destroy();
    await finished(output).catch(() => {});
    await fs.promises.unlink(output.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
});

describe("Parquet export file lifecycle", () => {
  it("validates the request before opening a file", async () => {
    const response = await request(app()).get("/transfers.parquet?maxRows=0");
    expect(response.status).toBe(400);
    expect(outputs).toHaveLength(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("does not open a writer when the truncation probe fails", async () => {
    const error = new Error("probe failed");
    findMany.mockRejectedValueOnce(error);

    const response = await request(app()).get("/transfers.parquet");

    expect(response.status).toBe(500);
    expect(receivedError).toBe(error);
    expect(outputs).toHaveLength(0);
  });

  it.each(["query", "append", "close"])(
    "closes and removes the file after a %s failure, preserving the original error",
    async (stage) => {
      const error = new Error(`${stage} failed`);
      findMany.mockResolvedValueOnce([]);
      if (stage === "query") {
        findMany.mockRejectedValueOnce(error);
      } else {
        findMany.mockResolvedValueOnce([transfer]);
        const method = stage === "append" ? "appendRow" : "close";
        jest.spyOn(parquet.ParquetWriter.prototype, method).mockRejectedValueOnce(error);
      }

      const response = await request(app()).get("/transfers.parquet?maxRows=1");

      expect(response.status).toBe(500);
      expect(receivedError).toBe(error);
      expect(outputs).toHaveLength(1);
      expect(outputs[0].closed).toBe(true);
      expect(fs.existsSync(outputs[0].path)).toBe(false);
    },
  );

  it("still downloads a readable capped Parquet file", async () => {
    findMany.mockResolvedValueOnce([{ id: 2 }]).mockResolvedValueOnce([transfer]);

    const response = await request(app()).get("/transfers.parquet?maxRows=1");

    expect(response.status).toBe(200);
    expect(response.headers["x-truncated"]).toBe("true");
    expect(response.headers["x-row-limit"]).toBe("1");
    const reader = await parquet.ParquetReader.openBuffer(response.body);
    try {
      const cursor = reader.getCursor();
      expect(await cursor.next()).toMatchObject({ amount: "10000000", eventId: "event-1" });
      expect(await cursor.next()).toBeNull();
    } finally {
      await reader.close();
    }
    expect(outputs).toHaveLength(1);
    expect(outputs[0].closed).toBe(true);
  });
});
