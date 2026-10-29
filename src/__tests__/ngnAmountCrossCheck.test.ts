/**
 * The naira cross-check at the point where both numbers exist.
 *
 * The router's band check sees only the webhook, so it cannot notice a scale
 * error: a 100x drift on a 1,000 naira order lands at 100,000, inside the
 * plausible band. reconcileNgnOrder is the first place the stored order amount
 * is loaded, so the comparison belongs there.
 */

type Row = Record<string, any>;

const tables: { ngnOrder: Row[] } = { ngnOrder: [] };

function locate(where: Row): Row | undefined {
  return tables.ngnOrder.find(
    (row) =>
      row.network === where.network_orderId.network &&
      row.orderId === where.network_orderId.orderId,
  );
}

jest.mock("../db", () => ({
  prisma: {
    ngnOrder: {
      findUnique: jest.fn(async ({ where }: Row) => locate(where) ?? null),
      update: jest.fn(async ({ where, data }: Row) => {
        const row = locate(where);
        if (!row) throw new Error("Record not found");
        Object.assign(row, data);
        return row;
      }),
    },
  },
}));

import { reconcileNgnOrder } from "../linq/ngnOrders";

/** A stored order. `amountNGN` is a String column, exactly as Prisma returns it. */
function seed(amountNGN: string): Row {
  const row: Row = {
    network: "mainnet",
    kind: "bill",
    orderId: "order-1",
    customerRef: "veil_test",
    walletAddress: "GSTUB",
    coin: "xlm",
    amountStableCoin: "0.68",
    amountNGN,
    rate: "1470",
    status: "pending",
    settledNGN: null,
  };
  tables.ngnOrder.push(row);
  return row;
}

let errors: string[];

beforeEach(() => {
  tables.ngnOrder.length = 0;
  errors = [];
  jest.spyOn(console, "error").mockImplementation((msg?: unknown) => {
    errors.push(String(msg));
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("reconcileNgnOrder naira cross-check", () => {
  it("accepts a webhook that agrees with the stored amount, and says nothing", async () => {
    const row = seed("1000");

    const handled = await reconcileNgnOrder({
      orderId: "order-1",
      network: "mainnet",
      event: "order.completed",
      status: "completed",
      amountNGN: 1000,
    });

    expect(handled).toBe(true);
    expect(row.settledNGN).toBe("1000");
    // The stored column is a String. If it were handed to the cross-check
    // unwidened, every webhook would be reported as "non-numeric" here.
    expect(errors).toEqual([]);
  });

  it("refuses to persist a figure that is exactly 100x the order", async () => {
    const row = seed("1000");

    const handled = await reconcileNgnOrder({
      orderId: "order-1",
      network: "mainnet",
      event: "order.completed",
      status: "completed",
      amountNGN: 100_000,
    });

    expect(handled).toBe(true);
    expect(row.status).toBe("completed");
    // The quoted amount survives rather than being overwritten with a corrupt one.
    expect(row.settledNGN).toBeNull();
    expect(errors.join("\n")).toMatch(/100× off the order|100x off the order/);
  });

  it("still records a small legitimate difference, and flags it", async () => {
    const row = seed("1000");

    await reconcileNgnOrder({
      orderId: "order-1",
      network: "mainnet",
      event: "order.completed",
      status: "completed",
      amountNGN: 995,
    });

    // An onramp depositor can transfer a little under or over the quote, and
    // settledNGN is the field whose job is to record what actually happened.
    expect(row.settledNGN).toBe("995");
    expect(errors.join("\n")).toMatch(/disagrees with order amountNGN/);
  });

  it("leaves settledNGN alone when the webhook carries no amount", async () => {
    const row = seed("1000");

    await reconcileNgnOrder({
      orderId: "order-1",
      network: "mainnet",
      event: "order.processing",
      status: "processing",
    });

    expect(row.settledNGN).toBeNull();
    expect(errors).toEqual([]);
  });
});
