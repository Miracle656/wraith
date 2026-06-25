/**
 * GraphQL API for Wraith with subscriptions support.
 *
 * Provides GraphQL schema and resolvers for querying and subscribing to
 * real-time TokenTransfer and HostFnLog events with filtering and backpressure.
 *
 * Features:
 * - Apollo Server for queries and mutations
 * - graphql-ws for WebSocket-based subscriptions
 * - Per-client filtering by contract/address
 * - Server-side backpressure handling to prevent OOM
 * - Persisted query support (for production)
 * - Cost/depth guards for query safety
 */

import { ApolloServer, BaseContext } from "@apollo/server";
import { makeExecutableSchema } from "@graphql-tools/schema";
import {
  subscribeToTransfers,
  subscribeToHostFnLogs,
  SubscriptionFilters,
} from "../api/subscriptions";
import {
  queryTransfers,
  queryAllTransfers,
  queryByTxHash,
  queryHostFnLogs,
  getLastIndexedLedger,
} from "../db";
import { getLatestLedger } from "../rpc";

// ─── GraphQL Schema ───────────────────────────────────────────────────────────

const typeDefs = `#graphql
  # ─── Enums ──────────────────────────────────────────────────────────────────

  enum EventType {
    TRANSFER
    MINT
    BURN
    CLAWBACK
  }

  # ─── Token Transfer Types ───────────────────────────────────────────────────

  """
  A token transfer event on the Soroban blockchain.
  Includes both SEP-41 standard transfers and other contract events (mint, burn, clawback).
  """
  type TokenTransfer {
    id: Int!
    contractId: String!
    eventType: EventType!
    fromAddress: String
    toAddress: String
    amount: String!
    """
    Human-readable amount formatted to 7 decimal places.
    Computed from amount in stroops (e.g., "10000000000" → "1000.0000000")
    """
    displayAmount: String!
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
    createdAt: String!
  }

  """
  Paginated list of token transfers with cursor for fetching more results.
  """
  type TokenTransferPage {
    rows: [TokenTransfer!]!
    nextCursor: String
  }

  # ─── Host Function Log Types ────────────────────────────────────────────────

  """
  A raw host-function invocation log. One row per contract event.
  Includes arbitrary contract events beyond just token transfers.
  """
  type HostFnLog {
    id: Int!
    contractId: String!
    functionName: String!
    args: String!
    result: String
    gasUsed: String
    ledger: Int!
    ledgerClosedAt: String!
    txHash: String!
    eventId: String!
    createdAt: String!
  }

  """
  Paginated list of host function logs with cursor for fetching more results.
  """
  type HostFnLogPage {
    rows: [HostFnLog!]!
    nextCursor: String
  }

  # ─── Subscription Events ────────────────────────────────────────────────────

  """
  Union of all subscription event types. Each subscription will yield events
  of one of these types depending on the subscription and filters.
  """
  union SubscriptionEvent = TransferSubscriptionEvent | HostFnLogSubscriptionEvent | BackpressureEvent

  """
  Real-time transfer event delivered via subscription.
  """
  type TransferSubscriptionEvent {
    type: String!
    data: TokenTransfer!
  }

  """
  Real-time host function log event delivered via subscription.
  """
  type HostFnLogSubscriptionEvent {
    type: String!
    data: HostFnLog!
  }

  """
  Backpressure notification: indicates the server dropped messages due to
  a slow consumer. Client should optimize filters or pause temporarily.
  """
  type BackpressureEvent {
    type: String!
    droppedCount: Int!
    queueSize: Int!
    message: String!
  }

  # ─── Server Status ──────────────────────────────────────────────────────────

  """
  Current indexer status and sync state.
  """
  type Status {
    lastIndexedLedger: Int!
    latestLedger: Int!
    isInSync: Boolean!
  }

  # ─── Queries ────────────────────────────────────────────────────────────────

  type Query {
    """
    Get transfers for a specific address (sender or recipient).
    Supports pagination with limit/cursor.
    """
    transfers(
      address: String!
      limit: Int = 100
      cursor: String
    ): TokenTransferPage!

    """
    Get all transfers (no address filter).
    Useful for archival/export use cases.
    """
    allTransfers(
      limit: Int = 100
      cursor: String
    ): TokenTransferPage!

    """
    Get transfers by transaction hash.
    """
    transfersByTxHash(txHash: String!): [TokenTransfer!]!

    """
    Get host function logs for a specific contract.
    """
    hostFnLogs(
      contractId: String!
      functionName: String
      limit: Int = 100
      cursor: String
    ): HostFnLogPage!

    """
    Get current indexer sync status.
    """
    status: Status!
  }

  # ─── Subscriptions ──────────────────────────────────────────────────────────

  type Subscription {
    """
    Subscribe to real-time token transfer events.
    Supports filtering by contract and sender/recipient addresses.
    
    Each event includes the full TokenTransfer data.
    If the client falls behind, backpressure events notify of dropped messages.
    """
    onTransfer(
      contracts: [String!]
      senders: [String!]
      recipients: [String!]
    ): SubscriptionEvent!

    """
    Subscribe to real-time host function log events.
    Supports filtering by contract.
    
    Note: Implemented as polling from database (interval: 1s).
    Each event includes the full HostFnLog data.
    """
    onHostFnLog(
      contracts: [String!]
    ): SubscriptionEvent!
  }
`;

// ─── Amount Formatting ────────────────────────────────────────────────────────

const STROOPS = 10_000_000n;

function toDisplayAmount(amount: string): string {
  const raw = BigInt(amount);
  const abs = raw < 0n ? -raw : raw;
  const integer = abs / STROOPS;
  const remainder = abs % STROOPS;
  const sign = raw < 0n ? "-" : "";
  return `${sign}${integer}.${String(remainder).padStart(7, "0")}`;
}

// ─── Resolvers ────────────────────────────────────────────────────────────────

interface Context extends BaseContext {}

const resolvers = {
  // Scalar types: JSON fields are returned as JSON strings for GraphQL compatibility
  TokenTransfer: {
    displayAmount: (parent: any) => parent.displayAmount,
    ledgerClosedAt: (parent: any) => {
      if (parent.ledgerClosedAt instanceof Date) {
        return parent.ledgerClosedAt.toISOString();
      }
      return String(parent.ledgerClosedAt);
    },
    createdAt: (parent: any) => {
      if (parent.createdAt instanceof Date) {
        return parent.createdAt.toISOString();
      }
      return String(parent.createdAt);
    },
  },

  HostFnLog: {
    args: (parent: any) => JSON.stringify(parent.args),
    result: (parent: any) =>
      parent.result ? JSON.stringify(parent.result) : null,
    gasUsed: (parent: any) =>
      parent.gasUsed ? parent.gasUsed.toString() : null,
    ledgerClosedAt: (parent: any) => {
      if (parent.ledgerClosedAt instanceof Date) {
        return parent.ledgerClosedAt.toISOString();
      }
      return String(parent.ledgerClosedAt);
    },
    createdAt: (parent: any) => {
      if (parent.createdAt instanceof Date) {
        return parent.createdAt.toISOString();
      }
      return String(parent.createdAt);
    },
  },

  // Event union resolver
  SubscriptionEvent: {
    __resolveType(value: any) {
      if (value.type === "transfer") return "TransferSubscriptionEvent";
      if (value.type === "hostFnLog") return "HostFnLogSubscriptionEvent";
      if (value.type === "backpressure") return "BackpressureEvent";
      return null;
    },
  },

  Query: {
    async transfers(
      _: any,
      {
        address,
        limit,
        cursor,
      }: { address: string; limit?: number; cursor?: string },
    ) {
      const result = await queryTransfers({
        address,
        direction: "incoming",
        limit,
        cursor,
      });
      return {
        rows: result.transfers.map((t) => ({
          ...t,
          displayAmount: toDisplayAmount((t as any).amount as string),
          ledgerClosedAt: (t as any).ledgerClosedAt,
          createdAt: (t as any).createdAt,
        })),
        nextCursor: result.nextCursor,
      };
    },

    async allTransfers(
      _: any,
      { limit, cursor }: { limit?: number; cursor?: string },
    ) {
      const result = await queryAllTransfers({
        address: "",
        limit,
        cursor,
      });
      return {
        rows: result.transfers.map((t) => ({
          ...t,
          displayAmount:
            (t as any).displayAmount || toDisplayAmount((t as any).amount),
          ledgerClosedAt: (t as any).ledgerClosedAt,
          createdAt: (t as any).createdAt,
        })),
        nextCursor: result.nextCursor,
      };
    },

    async transfersByTxHash(_: any, { txHash }: { txHash: string }) {
      const transfers = await queryByTxHash(txHash);
      return transfers.map((t) => ({
        ...t,
        displayAmount: toDisplayAmount(t.amount),
        ledgerClosedAt: t.ledgerClosedAt,
        createdAt: (t as any).createdAt || new Date(),
      }));
    },

    async hostFnLogs(
      _: any,
      {
        contractId,
        functionName,
        limit,
        cursor,
      }: {
        contractId: string;
        functionName?: string;
        limit?: number;
        cursor?: string;
      },
    ) {
      const result = await queryHostFnLogs({
        contractId,
        functionName,
        limit,
        cursor,
      });
      return {
        rows: result.rows,
        nextCursor: result.nextCursor,
      };
    },

    async status() {
      const lastIndexedLedger = (await getLastIndexedLedger()) ?? 0;
      const latestLedger = await getLatestLedger();

      return {
        lastIndexedLedger,
        latestLedger,
        isInSync: latestLedger - lastIndexedLedger <= 1,
      };
    },
  },

  Subscription: {
    async *onTransfer(
      _: any,
      {
        contracts,
        senders,
        recipients,
      }: {
        contracts?: string[];
        senders?: string[];
        recipients?: string[];
      },
    ) {
      const filters: SubscriptionFilters = {
        contracts: contracts || undefined,
        senders: senders || undefined,
        recipients: recipients || undefined,
      };

      for await (const event of subscribeToTransfers(filters)) {
        yield event;
      }
    },

    async *onHostFnLog(_: any, { contracts }: { contracts?: string[] }) {
      const filters: SubscriptionFilters = {
        contracts: contracts || undefined,
      };

      for await (const event of subscribeToHostFnLogs(filters)) {
        yield event;
      }
    },
  },
};

// ─── Server Creation ────────────────────────────────────────────────────────

/**
 * Create an Apollo Server instance configured for Wraith.
 * This server handles GraphQL queries and subscriptions.
 *
 * @returns ApolloServer instance ready to be integrated with express
 */
export function createGraphQLServer(): ApolloServer<Context> {
  const schema = makeExecutableSchema({
    typeDefs,
    resolvers,
  });

  return new ApolloServer<Context>({
    schema,
    introspection: true,
  });
}

export { SubscriptionFilters };
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
