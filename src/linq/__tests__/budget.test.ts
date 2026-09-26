/**
 * The provider call budget.
 *
 * These exist because the failure they guard against was invisible from the
 * server: every order creation succeeded, and users were still told cash out
 * was unavailable. The mobile client gave up after 20s while this server was
 * willing to spend about 103 — three 15s attempts plus waits inside `call`,
 * doubled by `retryOnProviderFailure`. Nothing here is slow enough to notice by
 * hand, so the arithmetic is asserted instead.
 */

import { LinqError, retryOnProviderFailure } from "../client";

describe("retryOnProviderFailure", () => {
  const serverError = () => new LinqError("Wallet generation failed", 500);

  it("retries once when the provider fails on its side", async () => {
    let calls = 0;
    const request = jest.fn(async () => {
      calls += 1;
      if (calls === 1) throw serverError();
      return "created";
    });

    await expect(retryOnProviderFailure(request, 1)).resolves.toBe("created");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("never retries a 4xx — that is about the request, not the provider", async () => {
    const request = jest.fn(async () => {
      throw new LinqError("Unsupported bank code", 400);
    });

    await expect(retryOnProviderFailure(request, 1)).rejects.toThrow("Unsupported bank code");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not retry past the deadline", async () => {
    const request = jest.fn(async () => {
      throw serverError();
    });

    // A deadline already in the past: the retry would finish after the client
    // has stopped listening, so it is not worth making.
    await expect(retryOnProviderFailure(request, 1_500, Date.now() - 1)).rejects.toThrow(
      "Wallet generation failed",
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("still retries when the deadline leaves room", async () => {
    let calls = 0;
    const request = jest.fn(async () => {
      calls += 1;
      if (calls === 1) throw serverError();
      return "created";
    });

    await expect(
      retryOnProviderFailure(request, 1, Date.now() + 30_000),
    ).resolves.toBe("created");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("surfaces a non-Linq error untouched", async () => {
    const request = jest.fn(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(retryOnProviderFailure(request, 1)).rejects.toThrow("fetch failed");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
