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

import { LinqError, retryOnProviderFailure, TOTAL_BUDGET_MS } from "../http";

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

  it("proves that retry plus wait cannot exceed the deadline", async () => {
    const request = jest.fn(async () => {
      throw serverError();
    });

    const now = Date.now();
    const delayMs = 1_500;
    // Exactly at or beyond the deadline after delayMs: skips retry
    await expect(retryOnProviderFailure(request, delayMs, now + delayMs)).rejects.toThrow(
      "Wallet generation failed",
    );
    expect(request).toHaveBeenCalledTimes(1);

    // If wait finishes strictly before the deadline, it is allowed to retry
    let attempt = 0;
    const allowedRequest = jest.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw serverError();
      return "created";
    });
    await expect(
      retryOnProviderFailure(allowedRequest, delayMs, now + delayMs + 500),
    ).resolves.toBe("created");
    expect(allowedRequest).toHaveBeenCalledTimes(2);
  });

  it("pins the default budget, which bounds a call made without a deadline", () => {
    // linqCall does `options.deadline ?? Date.now() + TOTAL_BUDGET_MS`, so this
    // constant is what stops a call with no deadline retrying open-endedly.
    //
    // This asserts the value, not the wiring — it catches the number being
    // edited, not the `??` being removed. The behaviour itself is covered by
    // the deadline tests above, which drive retryOnProviderFailure directly.
    expect(TOTAL_BUDGET_MS).toBe(35_000);
    expect(Number.isFinite(TOTAL_BUDGET_MS)).toBe(true);
  });

  it("surfaces a non-Linq error untouched", async () => {
    const request = jest.fn(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(retryOnProviderFailure(request, 1)).rejects.toThrow("fetch failed");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
