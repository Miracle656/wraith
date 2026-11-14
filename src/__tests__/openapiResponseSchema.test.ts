import express from "express";
import request from "supertest";
import {
  assertOpenApiResponse,
  consumeOpenApiValidationErrors,
  validateOpenApiResponse,
  withOpenApiResponseValidation,
} from "../openapi/responseValidator";

describe("OpenAPI response schema validation (#300)", () => {
  describe("money routes — valid responses pass", () => {
    it("accepts valid GET /offramp/availability (200 and 503)", () => {
      expect(
        validateOpenApiResponse("GET", "/offramp/availability", 200, { available: true }),
      ).toEqual([]);
      expect(
        validateOpenApiResponse("GET", "/offramp/availability", 503, {
          error: "Offramp is not configured on this deployment",
          code: "not_configured",
        }),
      ).toEqual([]);
    });

    it("accepts valid GET /offramp/rate (200 and 400)", () => {
      expect(
        validateOpenApiResponse("GET", "/offramp/rate?coin=xlm", 200, {
          coin: "xlm",
          rate: 290,
          indicative: true,
        }),
      ).toEqual([]);
      expect(
        validateOpenApiResponse("GET", "/offramp/rate?coin=doge", 400, {
          error: "coin must be one of: xlm, usdc",
          code: "invalid_coin",
        }),
      ).toEqual([]);
    });

    it("accepts valid POST /offramp/verify-bank and GET /offramp/trustline", () => {
      expect(
        validateOpenApiResponse("POST", "/offramp/verify-bank", 200, {
          accountName: "Ada Lovelace",
          bankName: "Test Bank",
          accountNumber: "0123456789",
          bankCode: "058",
        }),
      ).toEqual([]);
      expect(
        validateOpenApiResponse("GET", "/offramp/trustline?address=GABC", 200, {
          address: "GABC",
          valid: true,
          trustsUSDC: true,
        }),
      ).toEqual([]);
    });

    it("accepts valid POST /offramp/orders (201 created, 200 replayed, and 409 conflict)", () => {
      expect(
        validateOpenApiResponse("POST", "/offramp/orders", 201, {
          id: "ofr_1234567890123456789012",
          accessToken: "oft_1234567890123456789012345678901234567890123",
          walletAddress: "GDEPOSITADDRESS",
          chain: "stellar",
          coin: "usdc",
          coinType: "usdc",
          currency: "NGN",
          amountStableCoin: 50,
          amountNGN: 82750,
          rate: 1655,
          status: "initiated",
        }),
      ).toEqual([]);

      expect(
        validateOpenApiResponse("POST", "/offramp/orders", 200, {
          id: "ofr_1234567890123456789012",
          accessToken: "oft_1234567890123456789012345678901234567890123",
          walletAddress: "GDEPOSITADDRESS",
          chain: "stellar",
          coin: "usdc",
          amountStableCoin: 50,
          amountNGN: 82750,
          rate: 1655,
          status: "initiated",
          providerStatus: "initiated",
          replayed: true,
        }),
      ).toEqual([]);

      expect(
        validateOpenApiResponse("POST", "/offramp/orders", 409, {
          error: "This idempotencyKey has already been used",
          code: "idempotency_conflict",
        }),
      ).toEqual([]);
    });

    it("accepts valid GET /offramp/orders/{orderId} (live and cache)", () => {
      expect(
        validateOpenApiResponse("GET", "/offramp/orders/ofr_1234567890123456789012", 200, {
          id: "ofr_1234567890123456789012",
          status: "initiated",
          providerStatus: "initiated",
          amountStableCoin: 50,
          amountNGN: 82750,
          depositAddress: "GDEPOSITADDRESS",
          rate: 1655,
          createdAt: "2026-01-01T00:00:00.000Z",
          currency: "NGN",
          created: "2026-01-01T00:00:00Z",
          updated: "2026-01-01T00:00:00Z",
          source: "live",
        }),
      ).toEqual([]);

      expect(
        validateOpenApiResponse("GET", "/offramp/orders/ofr_1234567890123456789012", 200, {
          id: "ofr_1234567890123456789012",
          status: "initiated",
          providerStatus: "initiated",
          amountStableCoin: 50,
          amountNGN: 82750,
          depositAddress: "GDEPOSITADDRESS",
          rate: 1655,
          createdAt: "2026-01-01T00:00:00.000Z",
          source: "cache",
        }),
      ).toEqual([]);
    });

    it("accepts valid GET /fees, GET /ngn/customers/status, and GET /ngn/bills/data-bundles", () => {
      expect(
        validateOpenApiResponse("GET", "/fees", 200, {
          enabled: true,
          fees: {
            USDC: {
              amount: "0.25",
              assetCode: "USDC",
              assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
              destination: "GB3JS2AJZ3FKIGVOOPXDEYYR3XOHQA474WGCYAMNFSGX6OW5HGWCKUZW",
            },
          },
        }),
      ).toEqual([]);

      expect(
        validateOpenApiResponse("GET", "/ngn/customers/status?customerRef=veil_1", 200, {
          customerRef: "veil_1",
          verified: true,
          status: "verified",
        }),
      ).toEqual([]);

      expect(
        validateOpenApiResponse("GET", "/ngn/bills/data-bundles", 200, {
          bundles: [
            {
              provider: "MTN",
              code: "mtn-1gb-30d",
              label: "1 GB / 30 days",
              megabytes: 1024,
              validityDays: 30,
              amountNgn: 500,
            },
          ],
        }),
      ).toEqual([]);
    });
  });

  describe("directional failure messages — names the diverging field and direction", () => {
    it("names an extra top-level or nested field", () => {
      const topLevel = validateOpenApiResponse("GET", "/offramp/rate", 200, {
        coin: "xlm",
        rate: 290,
        indicative: true,
        currency: "NGN",
      });
      expect(topLevel).toEqual(["response has an extra field `currency`"]);

      const nested = validateOpenApiResponse("GET", "/fees", 200, {
        enabled: true,
        fees: {
          USDC: {
            amount: "0.25",
            assetCode: "USDC",
            assetIssuer: null,
            destination: "GB3JS2AJZ3FKIGVOOPXDEYYR3XOHQA474WGCYAMNFSGX6OW5HGWCKUZW",
            undocumentedField: 123,
          },
        },
      });
      expect(nested).toEqual(["response has an extra field `fees.USDC.undocumentedField`"]);
    });

    it("names a missing required field", () => {
      const missing = validateOpenApiResponse("POST", "/offramp/orders", 201, {
        id: "ofr_1234567890123456789012",
        // accessToken omitted!
        walletAddress: "GDEPOSITADDRESS",
        chain: "stellar",
        coin: "usdc",
        amountStableCoin: 50,
        amountNGN: 82750,
        rate: 1655,
        status: "initiated",
      });
      expect(missing).toEqual(["response is missing required field `accessToken`"]);
    });

    it("names a field whose type diverged", () => {
      const wrongType = validateOpenApiResponse("GET", "/offramp/rate", 200, {
        coin: "xlm",
        rate: "290",
        indicative: true,
      });
      expect(wrongType).toEqual(["field `rate` has wrong type: expected number, got string"]);
    });

    it("names a field whose enum value diverged", () => {
      const wrongEnum = validateOpenApiResponse(
        "GET",
        "/offramp/orders/ofr_1234567890123456789012",
        200,
        {
          id: "ofr_1234567890123456789012",
          status: "initiated",
          providerStatus: "initiated",
          amountStableCoin: 50,
          amountNGN: 82750,
          depositAddress: "GDEPOSITADDRESS",
          rate: 1655,
          createdAt: "2026-01-01T00:00:00.000Z",
          source: "linq",
        },
      );
      expect(wrongEnum).toEqual([
        'field `source` has value "linq", expected one of ["live","cache"]',
      ]);
    });

    it("flags an undocumented HTTP status code on a documented route", () => {
      const badStatus = validateOpenApiResponse("GET", "/offramp/availability", 418, {
        error: "teapot",
      });
      expect(badStatus[0]).toMatch(
        /status 418 is not documented for GET \/offramp\/availability/,
      );
    });

    it("throws a descriptive Error from assertOpenApiResponse on divergence", () => {
      expect(() =>
        assertOpenApiResponse("GET", "/offramp/availability", 200, {
          available: true,
          leakedSecret: "x",
        }),
      ).toThrow(/response has an extra field `leakedSecret`/);
    });
  });

  describe("withOpenApiResponseValidation — catches handler-vs-spec drift on Express routes", () => {
    it("catches a handler returning an undocumented extra field, missing field, or wrong type", async () => {
      const app = express();
      app.get("/offramp/rate", (_req, res) => {
        // Deliberate drift: extra `providerName` field, missing `indicative`, and string `rate`
        res.status(200).json({
          coin: "usdc",
          rate: "1655",
          providerName: "linq",
        });
      });
      withOpenApiResponseValidation(app);

      await request(app).get("/offramp/rate");
      const errors = consumeOpenApiValidationErrors();

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("response is missing required field `indicative`");
      expect(errors[0].message).toContain(
        "field `rate` has wrong type: expected number, got string",
      );
      expect(errors[0].message).toContain("response has an extra field `providerName`");
    });
  });
});
