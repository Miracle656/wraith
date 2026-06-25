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

const typeDefs = `#graphql
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
      limit: Int = 50
      offset: Int = 0
    ): TransferConnection!
    transferByTx(txHash: String!): [Transfer!]!
    summary(address: String!, contractId: String): [TokenSummary!]!
  }
`;

type TransferDirection = "INCOMING" | "OUTGOING" | "ALL";

function formatTransfer(row: Record<string, unknown>) {
  return {
    ...row,
    ledgerClosedAt:
      row.ledgerClosedAt instanceof Date
        ? row.ledgerClosedAt.toISOString()
        : String(row.ledgerClosedAt),
  };
}

const resolvers = {
  Query: {
    health: () => ({ ok: true, version: process.env.npm_package_version ?? "1.0.0" }),

    transfers: async (
      _parent: unknown,
      args: {
        address: string;
        direction: TransferDirection;
        contractId?: string;
        limit?: number;
        offset?: number;
      }
    ) => {
      const common = {
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

    transferByTx: async (_parent: unknown, args: { txHash: string }) => {
      const transfers = await queryByTxHash(args.txHash);
      return (transfers as Array<Record<string, unknown>>).map((transfer) =>
        formatTransfer(transfer)
      );
    },

    summary: async (
      _parent: unknown,
      args: { address: string; contractId?: string }
    ) => {
      const rows = await querySummary(args);
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
  const server = new ApolloServer({
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

  return expressMiddleware(server);
}
