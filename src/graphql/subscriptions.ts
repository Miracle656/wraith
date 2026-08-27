/**
 * GraphQL subscriptions over WebSocket (#99).
 *
 * Streams newly-ingested TokenTransfer / HostFnLog rows to subscribed
 * clients, with per-client contract filters and bounded per-subscriber
 * queues so a slow consumer can't grow server memory unboundedly.
 *
 * Built directly on `graphql` + `ws` (both already dependencies) rather
 * than the graphql-ws / subscriptions-transport-ws packages, using a small
 * JSON message protocol modelled on graphql-ws:
 *
 *   → { id, type: "subscribe", payload: { query, variables? } }
 *   ← { id, type: "next", payload: <ExecutionResult> }   (repeated)
 *   ← { id, type: "error", payload: [<GraphQLError>] }
 *   ← { id, type: "complete" }
 *   → { id, type: "complete" }                            (client unsubscribes)
 */
import {
  GraphQLObjectType,
  GraphQLSchema,
  buildSchema,
  parse,
  subscribe,
  validate,
  type ExecutionResult,
  type GraphQLFieldResolver,
} from "graphql";
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "http";
import { typeDefs as baseTypeDefs, resolvers as baseResolvers, formatTransfer } from "./server";
import { toDisplayAmount } from "../api";
import {
  transferEmitter,
  hostFnLogEmitter,
  eventsToAsyncIterator,
  filterAsyncIterator,
  type TransferEvent,
  type HostFnLogEvent,
} from "../events";

export const SUBSCRIPTIONS_PATH = "/graphql/subscriptions";

// Refuse to enqueue more data on an already-saturated socket — the client
// simply misses the update rather than the server buffering it forever.
const MAX_BUFFERED_BYTES = 1_000_000;

const subscriptionTypeDefs = `#graphql
  scalar JSON

  type HostFnLog {
    contractId: String!
    functionName: String!
    args: JSON
    result: JSON
    ledger: Int!
    ledgerClosedAt: String!
    txHash: String!
    eventId: String!
  }

  type Subscription {
    transferAdded(contractId: String): Transfer!
    hostFnLogAdded(contractId: String): HostFnLog!
  }
`;

function formatHostFnLog(log: HostFnLogEvent) {
  return {
    ...log,
    ledgerClosedAt:
      log.ledgerClosedAt instanceof Date
        ? log.ledgerClosedAt.toISOString()
        : String(log.ledgerClosedAt),
  };
}

type FieldResolverMap = Record<
  string,
  | GraphQLFieldResolver<unknown, unknown>
  | { subscribe?: GraphQLFieldResolver<unknown, unknown>; resolve?: GraphQLFieldResolver<unknown, unknown> }
>;

/**
 * graphql-js's `buildSchema` produces a schema with default (identity)
 * resolvers only. Attach the real Query resolvers plus our Subscription
 * resolvers onto the built schema — the same technique makeExecutableSchema
 * uses under the hood, without needing that package as a dependency.
 */
function attachResolvers(schema: GraphQLSchema, resolverMap: Record<string, FieldResolverMap>): void {
  for (const [typeName, fields] of Object.entries(resolverMap)) {
    const type = schema.getType(typeName);
    if (!(type instanceof GraphQLObjectType)) continue;

    const typeFields = type.getFields();
    for (const [fieldName, fieldResolver] of Object.entries(fields)) {
      const field = typeFields[fieldName];
      if (!field) continue;

      if (typeof fieldResolver === "function") {
        field.resolve = fieldResolver;
      } else {
        if (fieldResolver.subscribe) field.subscribe = fieldResolver.subscribe;
        if (fieldResolver.resolve) field.resolve = fieldResolver.resolve;
      }
    }
  }
}

function buildSubscriptionSchema(): GraphQLSchema {
  const schema = buildSchema(baseTypeDefs + subscriptionTypeDefs);

  attachResolvers(schema, baseResolvers);
  attachResolvers(schema, {
    Subscription: {
      transferAdded: {
        subscribe: (_parent, args: { contractId?: string }) =>
          filterAsyncIterator<TransferEvent>(
            eventsToAsyncIterator<TransferEvent>(transferEmitter, "transfer:new"),
            (t) => !args.contractId || t.contractId === args.contractId
          ),
        resolve: (payload: unknown) => {
          const transfer = payload as TransferEvent;
          return {
            ...formatTransfer(transfer as unknown as Record<string, unknown>),
            displayAmount: toDisplayAmount(transfer.amount),
          };
        },
      },
      hostFnLogAdded: {
        subscribe: (_parent, args: { contractId?: string }) =>
          filterAsyncIterator<HostFnLogEvent>(
            eventsToAsyncIterator<HostFnLogEvent>(hostFnLogEmitter, "hostfnlog:new"),
            (l) => !args.contractId || l.contractId === args.contractId
          ),
        resolve: (payload: unknown) => formatHostFnLog(payload as HostFnLogEvent),
      },
    },
  });

  return schema;
}

interface ClientMessage {
  id?: string;
  type?: "subscribe" | "complete";
  payload?: { query?: string; variables?: Record<string, unknown> };
}

/**
 * Attach a WebSocket server implementing GraphQL subscriptions.
 *
 * Clients connect to: ws://host/graphql/subscriptions
 */
export function attachGraphQLSubscriptions(server: Server): void {
  const schema = buildSubscriptionSchema();
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = req.url ?? "";
    // Owns the whole /graphql/* upgrade namespace (ws.ts explicitly defers
    // it here) so any unmatched sub-path still gets a clean 404 instead of
    // hanging with no response.
    if (!url.startsWith("/graphql/")) return;
    if (!url.startsWith(SUBSCRIPTIONS_PATH)) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    // One entry per active subscription id on this connection, so a
    // "complete" message or socket close can release its async iterator.
    const active = new Map<string, AsyncIterator<ExecutionResult>>();

    const send = (msg: Record<string, unknown>) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) return;
      ws.send(JSON.stringify(msg));
    };

    const stop = (id: string) => {
      const iterator = active.get(id);
      active.delete(id);
      iterator?.return?.(undefined);
    };

    ws.on("message", (data: Buffer | string) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        send({ type: "error", payload: [{ message: "Invalid JSON" }] });
        return;
      }

      if (msg.type === "complete") {
        if (msg.id) stop(msg.id);
        return;
      }

      if (msg.type !== "subscribe" || !msg.id || !msg.payload?.query) return;
      const { id } = msg;
      const { query, variables } = msg.payload;

      void (async () => {
        let document;
        try {
          document = parse(query);
        } catch (err) {
          send({ id, type: "error", payload: [{ message: (err as Error).message }] });
          return;
        }

        const validationErrors = validate(schema, document);
        if (validationErrors.length > 0) {
          send({ id, type: "error", payload: validationErrors.map((e) => ({ message: e.message })) });
          return;
        }

        const result = await subscribe({ schema, document, variableValues: variables });

        if (!(Symbol.asyncIterator in result)) {
          send({
            id,
            type: "error",
            payload: (result as ExecutionResult).errors ?? [{ message: "Subscription failed" }],
          });
          return;
        }

        const iterator = result as AsyncIterableIterator<ExecutionResult>;
        active.set(id, iterator);

        try {
          for await (const event of iterator) {
            if (!active.has(id)) break; // client unsubscribed mid-stream
            send({ id, type: "next", payload: event });
          }
          if (active.has(id)) {
            active.delete(id);
            send({ id, type: "complete" });
          }
        } catch (err) {
          active.delete(id);
          send({ id, type: "error", payload: [{ message: (err as Error).message }] });
        }
      })();
    });

    const cleanup = () => {
      for (const id of [...active.keys()]) stop(id);
    };
    ws.on("close", cleanup);
    ws.on("error", cleanup);
  });
}
