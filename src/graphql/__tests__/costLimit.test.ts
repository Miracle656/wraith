/**
 * The cost limiter (#279).
 *
 * `src/graphql/costLimit.ts` was the only module in src/ with no test at all,
 * and it is a denial-of-service control: it decides which queries are too
 * expensive to run. An untested limiter is a limiter nobody has watched
 * refuse anything.
 *
 * These pin what it promises:
 *
 *  - a query over the ceiling is refused, and the refusal names the computed
 *    cost and the ceiling, so a legitimate caller knows what to change;
 *  - a query under the ceiling runs, untouched;
 *  - the arithmetic the refusal reports is exact for a known query;
 *  - the shapes the limiter exists for — cheap to write, expensive to run:
 *    deep nesting and a wide field selection.
 *
 * Nothing here reaches a database or a provider; the plugin only parses.
 */
import { ApolloServer } from "@apollo/server";
import { GraphQLError } from "graphql";
import { costLimitPlugin, type CostLimitOptions } from "../costLimit";

type RequestContext = Parameters<
  NonNullable<ReturnType<typeof costLimitPlugin>["requestDidStart"]>
>[0];

/** Run the plugin's request hook on `query`, the way Apollo Server does. */
async function requestDidStart(query: string | undefined, options?: CostLimitOptions): Promise<void> {
  const hook = costLimitPlugin(options).requestDidStart;
  await hook?.({ request: { query } } as unknown as RequestContext);
}

/** A query nested `levels` fields deep — few fields, all of them nested. */
function deeplyNested(levels: number): string {
  let inner = `f${levels}`;
  for (let level = levels - 1; level >= 1; level--) {
    inner = `f${level} { ${inner} }`;
  }
  return `{ ${inner} }`;
}

describe("costLimitPlugin", () => {
  describe("a query under the ceiling runs", () => {
    it("lets an ordinary query through untouched", async () => {
      await expect(requestDidStart("{ health { ok version } }")).resolves.toBeUndefined();
    });

    it("does nothing when there is no query to judge", async () => {
      await expect(requestDidStart(undefined)).resolves.toBeUndefined();
    });

    // The limiter parses to measure; a syntax error is GraphQL validation's
    // problem, not the limiter's, and must not be swallowed or re-thrown as a
    // cost refusal.
    it("leaves a query it cannot parse to GraphQL's own validation", async () => {
      await expect(requestDidStart("{ health { ok ")).resolves.toBeUndefined();
    });
  });

  describe("a query over the ceiling is refused", () => {
    it("refuses on cost, naming the computed cost and the ceiling", async () => {
      // `{ health { ok version } }` is three fields at the default weight of
      // one each: the refusal must name both numbers so a legitimate caller
      // can tell what to change.
      await expect(requestDidStart("{ health { ok version } }", { maxCost: 2 })).rejects.toThrow(
        "Query cost 3 exceeds the maximum allowed cost of 2",
      );
    });

    it("computes the cost of a known query exactly", async () => {
      const refusal = await requestDidStart("{ a b c d e }", { maxCost: 4 }).catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(GraphQLError);
      expect((refusal as GraphQLError).message).toBe(
        "Query cost 5 exceeds the maximum allowed cost of 4",
      );
    });

    it("counts a field's configured weight, not just its presence", async () => {
      // edges { node { id } } is three fields, but `node` is where the list
      // work happens, so it is priced above its field count.
      await expect(
        requestDidStart("{ transfers { edges { node { id } } } }", {
          maxCost: 52,
          fieldCost: { node: 50 },
        }),
      ).rejects.toThrow("Query cost 53 exceeds the maximum allowed cost of 52");
    });

    // The shape a query-complexity attack actually takes: eleven fields, each
    // inside the last. Cost 11 passes every ceiling that matters; the depth is
    // the danger, and only the depth check catches it.
    it("refuses deep nesting that the cost alone would wave through", async () => {
      await expect(requestDidStart(deeplyNested(11))).rejects.toThrow(
        "Query depth 11 exceeds the maximum allowed depth of 10",
      );
    });

    // The other cheap-to-write-expensive-to-run shape: one level, a thousand
    // and one fields, at the default ceiling of 1000.
    it("refuses a wide field selection at the default ceiling", async () => {
      const wide = Array.from({ length: 1_001 }, (_, i) => `f${i}`).join(" ");
      await expect(requestDidStart(`{ ${wide} }`)).rejects.toThrow(
        "Query cost 1001 exceeds the maximum allowed cost of 1000",
      );
    });

    it("names the depth even when the cost is over the ceiling too", async () => {
      await expect(requestDidStart(deeplyNested(11), { maxCost: 1 })).rejects.toThrow(
        "Query depth 11 exceeds the maximum allowed depth of 10",
      );
    });
  });

  // Unit-driving the hook pins the refusal's wording; this pins that the
  // plugin, wired into a real server, actually refuses rather than merely
  // throwing at whoever calls it.
  describe("through a real ApolloServer", () => {
    const typeDefs = /* GraphQL */ `
      type Health {
        ok: Boolean!
        version: String!
      }

      type Query {
        health: Health
      }
    `;

    const health = jest.fn(() => ({ ok: true, version: "1.0.0" }));

    const server = new ApolloServer({
      typeDefs,
      resolvers: {
        Query: { health },
      },
      plugins: [costLimitPlugin({ maxDepth: 5, maxCost: 2 })],
    });

    beforeAll(async () => {
      await server.start();
    });

    afterAll(async () => {
      await server.stop();
    });

    it("runs an under-cost query and returns its data", async () => {
      const res = await server.executeOperation({ query: "{ health { ok } }" });
      if (res.body?.kind !== "single") throw new Error("expected a single result");
      expect(res.body.singleResult.data).toEqual({ health: { ok: true } });
      expect(res.body.singleResult.errors).toBeUndefined();
      expect(health).toHaveBeenCalledTimes(1);
    });

    // A refusal in requestDidStart fails the whole request in Apollo Server —
    // no response, and above all no resolver work. The limiter's job is to
    // refuse before anything expensive happens, so the resolver not running
    // is the assertion that matters.
    it("refuses an over-cost query before any resolver runs", async () => {
      await expect(
        server.executeOperation({ query: "{ health { ok version } }" }),
      ).rejects.toThrow();
      expect(health).not.toHaveBeenCalled();
    });
  });
});
