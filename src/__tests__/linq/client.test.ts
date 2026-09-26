/**
 * The client is the only thing standing between a wallet request and an order
 * that pays real naira, so these pin the decisions that are expensive to get
 * wrong and invisible when they are.
 */
import {
  getRate,
  retryOnProviderFailure,
  createOfframpOrder,
  checkStellarTrustline,
  LinqError,
} from "../../linq/client";

const OK = (body: unknown) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(body),
});

const ERR = (status: number, message: string) => ({
  ok: false,
  status,
  text: async () => JSON.stringify({ message }),
});

describe("createOfframpOrder", () => {
  beforeEach(() => {
    process.env.LINQ_API_KEY = "biz_live_test";
  });

  it("always sends chain:stellar — Linq defaults to Sui, and coin does not select the chain", async () => {
    const fetchMock = jest.fn().mockResolvedValue(OK({ id: "1", chain: "stellar" }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await createOfframpOrder({
      amountNGN: 2000,
      bankAccount: "1234567890",
      bankCode: "033",
      bankName: "UBA",
      accountName: "John Doe",
      idempotencyKey: "k1",
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // Funds sent to an address on the wrong chain are unrecoverable.
    expect(body.chain).toBe("stellar");
    expect(body.coin).toBe("usdc");
  });

  it("sends manualDeposit so the payout follows what actually arrived", async () => {
    const fetchMock = jest.fn().mockResolvedValue(OK({ id: "1" }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await createOfframpOrder({
      amountNGN: 2000,
      bankAccount: "1234567890",
      bankCode: "033",
      bankName: "UBA",
      accountName: "John Doe",
      idempotencyKey: "k2",
    });

    // With the default (false) the full locked NGN is paid out even when less
    // USDC turns up, and the shortfall is ours.
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).manualDeposit).toBe(true);
  });

  it("refuses both amount modes at once rather than letting Linq pick", async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    await expect(
      createOfframpOrder({
        amountNGN: 2000,
        amountStableCoin: 1.22,
        bankAccount: "1234567890",
        bankCode: "033",
        bankName: "UBA",
        accountName: "John Doe",
        idempotencyKey: "k3",
      }),
    ).rejects.toBeInstanceOf(LinqError);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("refuses neither amount mode", async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    await expect(
      createOfframpOrder({
        bankAccount: "1234567890",
        bankCode: "033",
        bankName: "UBA",
        accountName: "John Doe",
        idempotencyKey: "k4",
      }),
    ).rejects.toBeInstanceOf(LinqError);
  });

  it("surfaces Linq's own message, which explains the problem better than ours would", async () => {
    global.fetch = jest.fn().mockResolvedValue(ERR(400, "Invalid bank code")) as unknown as typeof fetch;
    await expect(
      createOfframpOrder({
        amountNGN: 2000,
        bankAccount: "1234567890",
        bankCode: "999",
        bankName: "Nope",
        accountName: "John Doe",
        idempotencyKey: "k5",
      }),
    ).rejects.toThrow("Invalid bank code");
  });
});

describe("checkStellarTrustline", () => {
  beforeEach(() => {
    process.env.LINQ_API_KEY = "biz_live_test";
  });

  it("reports an account with no USDC trustline", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(OK({ address: "G...", valid: true, trustsUSDC: false })) as unknown as typeof fetch;
    await expect(checkStellarTrustline("G...")).resolves.toMatchObject({ trustsUSDC: false });
  });

  it("treats a 503 as unknown, not as a refusal", async () => {
    // Linq's docs are explicit: 503 means Horizon was unreachable. Rejecting
    // the address there turns a Stellar outage into a failed sell, and the
    // refund path re-checks the trustline before paying anything anyway.
    global.fetch = jest
      .fn()
      .mockResolvedValue(ERR(503, "Horizon unreachable")) as unknown as typeof fetch;
    await expect(checkStellarTrustline("G...")).resolves.toMatchObject({ trustsUSDC: true });
  });

  it("still propagates a genuine 400", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(ERR(400, "Not a Stellar public key")) as unknown as typeof fetch;
    await expect(checkStellarTrustline("nope")).rejects.toThrow("Not a Stellar public key");
  });
});

describe("retryOnProviderFailure", () => {
  it("retries once when the provider fails on its side", async () => {
    const request = jest
      .fn()
      .mockRejectedValueOnce(new LinqError("Wallet generation failed", 500))
      .mockResolvedValueOnce({ id: "ord_1" });

    await expect(retryOnProviderFailure(request, 0)).resolves.toEqual({ id: "ord_1" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("gives up after one retry", async () => {
    const request = jest.fn().mockRejectedValue(new LinqError("Wallet generation failed", 500));

    await expect(retryOnProviderFailure(request, 0)).rejects.toThrow("Wallet generation failed");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("never retries a rejection of the request itself", async () => {
    const request = jest.fn().mockRejectedValue(new LinqError("Invalid account", 400));

    await expect(retryOnProviderFailure(request, 0)).rejects.toThrow("Invalid account");
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("provider rate limits", () => {
  const limited = (body: string) => ({
    ok: false,
    status: 429,
    headers: { get: (h: string) => (h.toLowerCase() === "retry-after" ? "0" : null) },
    text: async () => body,
  });

  it("waits and retries a 429 instead of handing it to the user", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(limited("Rate limit exceeded, please wait"))
      .mockResolvedValueOnce(OK({ rate: 1363.4 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(getRate()).resolves.toEqual({ rate: 1363.4 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps a plain-text error body as the message, with its real status", async () => {
    const fetchMock = jest.fn().mockResolvedValue(limited("Rate limit exceeded, please wait"));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(getRate()).rejects.toMatchObject({
      status: 429,
      message: "Rate limit exceeded, please wait",
    });
    // The first attempt plus two retries, then it gives up.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
