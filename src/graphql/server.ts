/**
 * GraphQL API for Wraith with subscriptions support.
 *
 * Provides GraphQL schema and resolvers for querying and subscribing to
 * real-time TokenTransfer and HostFnLog events with filtering and backpressure.
 *
 * Features:
 * - Apollo Server 5 for queries and mutations
 * - graphql-ws for WebSocket-based subscriptions
 * - Per-client filtering by contract/address
 * - Server-side backpressure handling to prevent OOM
 * - Persisted query support (for production)
 * - Cost/depth guards for query safety
 */

import { ApolloServer, BaseContext } from "@apollo/server";
import { expressMiddleware } from "@as-integrations/express4";
import { makeExecutableSchema } from "@graphql-tools/schema";
import type { RequestHandler } from "express";
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
import { costLimitPlugin } from "./costLimit";
import { persistedQueryPlugin } from "./persisted";

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

  const server = new ApolloServer<Context>({
    schema,
    introspection: true,
    plugins: [
      persistedQueryPlugin,
      costLimitPlugin({
        maxDepth: Number(process.env.GRAPHQL_MAX_DEPTH) || 10,
        maxCost: Number(process.env.GRAPHQL_MAX_COST) || 1000,
      }),
    ],
  });

  return server;
}

export { SubscriptionFilters };

/**
 * Create GraphQL middleware for Express.
 * Used in development and when subscriptions are not required.
 *
 * @param server Optional pre-created Apollo Server (useful for testing)
 * @returns Express middleware
 */
export function createGraphQLMiddleware(
  server?: ApolloServer<Context>,
): RequestHandler {
  const gqlServer = server || createGraphQLServer();

  return expressMiddleware(gqlServer, {
    context: async () => ({}),
  });
}
