import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@as-integrations/express4";
import {
  queryAllTransfers,
  queryByTxHash,
  querySummary,
  queryTransfers,
} from "../db";
import { costLimitPlugin } from "./costLimit";
import { persistedQueryPlugin } from "./persisted";
import { requestNetwork } from "../middleware/network";
import { enabledNetworks, isNetwork, NETWORKS, currentNetwork, type Network } from "../network";

export const typeDefs = `#graphql
  enum Network {
    TESTNET
    MAINNET
  }

  enum TransferDirection {
    INCOMING
    OUTGOING
    ALL
  }

  type GraphQLHealth {
    ok: Boolean!
    version: String!
  }

  type Transfer {
    contractId: String!
    eventType: String!
    fromAddress: String
    toAddress: String
    amount: String!
    displayAmount: String
    ledger: Int!
    ledgerClosedAt: String!
    txHash: String!
    eventId: String!
    direction: String
  }

  type TransferConnection {
    total: Int!
    transfers: [Transfer!]!
    nextCursor: String
  }

  type TokenSummary {
    contractId: String!
    totalReceived: String!
    totalSent: String!
    netFlow: String!
    txCount: Int!
  }

  type Query {
    health: GraphQLHealth!
    transfers(
      address: String!
      direction: TransferDirection = ALL
      contractId: String
      network: Network
      limit: Int = 50
      offset: Int = 0
    ): TransferConnection!
    transferByTx(txHash: String!, network: Network): [Transfer!]!
    summary(address: String!, contractId: String, network: Network): [TokenSummary!]!
  }
`;

type TransferDirection = "INCOMING" | "OUTGOING" | "ALL";
type NetworkArg = "TESTNET" | "MAINNET";

/** What every resolver receives: the network the HTTP request selected (#163). */
export interface GraphQLContext {
  network: Network;
}

/**
 * Decide which network one field reads from.
 *
 * A field-level `network:` argument wins over the request-level selector, so a
 * single document can compare two chains in one round-trip. With neither, the
 * context's network applies — which is the `?network=` / `X-Network` value, and
 * failing that the process default.
 *
 * An argument naming a network this deployment does not serve throws rather
 * than returning nothing: an empty list would read as "no such transfers"
 * instead of "this process has never indexed that chain".
 */
function resolveArgNetwork(arg: NetworkArg | undefined, ctx: GraphQLContext | undefined): Network {
  if (arg === undefined) return ctx?.network ?? currentNetwork();

  const normalised = arg.toLowerCase();
  if (!isNetwork(normalised)) {
    throw new Error(`Invalid network: "${arg}". Valid values: ${NETWORKS.join(", ")}.`);
  }

  const enabled = enabledNetworks();
  if (!enabled.includes(normalised)) {
    throw new Error(
      `Network "${normalised}" is not enabled on this deployment. Enabled networks: ${enabled.join(", ")}.`
    );
  }

  return normalised;
}

export function formatTransfer(row: Record<string, unknown>) {
  return {
    ...row,
    ledgerClosedAt:
      row.ledgerClosedAt instanceof Date
        ? row.ledgerClosedAt.toISOString()
        : String(row.ledgerClosedAt),
  };
}

export const resolvers = {
  Query: {
    health: () => ({ ok: true, version: process.env.npm_package_version ?? "1.0.0" }),

    transfers: async (
      _parent: unknown,
      args: {
        address: string;
        direction: TransferDirection;
        contractId?: string;
        network?: NetworkArg;
        limit?: number;
        offset?: number;
      },
      ctx?: GraphQLContext
    ) => {
      const common = {
        network: resolveArgNetwork(args.network, ctx),
        address: args.address,
        contractId: args.contractId,
        limit: args.limit,
        offset: args.offset,
      };

      const result =
        args.direction === "INCOMING"
          ? await queryTransfers({ ...common, direction: "incoming" })
          : args.direction === "OUTGOING"
            ? await queryTransfers({ ...common, direction: "outgoing" })
            : await queryAllTransfers(common);

      return {
        ...result,
        transfers: result.transfers.map((transfer) =>
          formatTransfer(transfer as Record<string, unknown>)
        ),
      };
    },

    transferByTx: async (
      _parent: unknown,
      args: { txHash: string; network?: NetworkArg },
      ctx?: GraphQLContext
    ) => {
      const transfers = await queryByTxHash(args.txHash, resolveArgNetwork(args.network, ctx));
      return (transfers as Array<Record<string, unknown>>).map((transfer) =>
        formatTransfer(transfer)
      );
    },

    summary: async (
      _parent: unknown,
      args: { address: string; contractId?: string; network?: NetworkArg },
      ctx?: GraphQLContext
    ) => {
      const rows = await querySummary({
        address: args.address,
        contractId: args.contractId,
        network: resolveArgNetwork(args.network, ctx),
      });
      return rows.map((row) => {
        const received = BigInt(row.totalReceived);
        const sent = BigInt(row.totalSent);

        return {
          contractId: row.contractId,
          totalReceived: row.totalReceived,
          totalSent: row.totalSent,
          netFlow: (received - sent).toString(),
          txCount: Number(row.txCount),
        };
      });
    },
  },
};

function readPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function createGraphQLMiddleware() {
  const server = new ApolloServer<GraphQLContext>({
    typeDefs,
    resolvers,
    persistedQueries: false,
    plugins: [
      persistedQueryPlugin,
      costLimitPlugin({
        maxDepth: readPositiveInt("GRAPHQL_MAX_DEPTH", 10),
        maxCost: readPositiveInt("GRAPHQL_MAX_COST", 1000),
      }),
    ],
  });

  server.startInBackgroundHandlingStartupErrorsByLoggingAndFailingAllRequests();

  // The HTTP-level selector reaches resolvers through the context, so
  // `?network=` and `X-Network` work on /graphql exactly as on the REST routes
  // — the networkMiddleware has already validated it by the time we read it.
  return expressMiddleware(server, {
    context: async ({ req }) => ({ network: requestNetwork(req) }),
  });
}
