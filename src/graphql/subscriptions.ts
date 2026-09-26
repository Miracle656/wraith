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
import { typeDefs as baseTypeDefs, resolvers as baseResolvers, formatTransfer, type GraphQLContext } from "./server";
import { toDisplayAmount } from "../api";
import {
  transferEmitter,
  hostFnLogEmitter,
  eventsToAsyncIterator,
  filterAsyncIterator,
  type TransferEvent,
  type HostFnLogEvent,
} from "../events";
import { resolveSocketNetwork } from "../ws";
import type { Network } from "../network";

export const SUBSCRIPTIONS_PATH = "/graphql/subscriptions";

// Refuse to enqueue more data on an already-saturated socket — the client
// simply misses the update rather than the server buffering it forever.
const MAX_BUFFERED_BYTES = 1_000_000;

// How long to wait before telling a client how many messages it missed. Long
// enough that a burst of drops collapses into one notice.
const BACKPRESSURE_NOTICE_MS = 250;

/** The subset of a WebSocket the sender needs, so it can be tested without one. */
export interface SendableSocket {
  readyState: number;
  bufferedAmount: number;
  send(data: string): void;
}

/**
 * Build the per-connection `send` used by every subscription on that socket.
 *
 * Dropping on a saturated socket is what keeps one slow consumer from growing
 * server memory without bound. But dropping *silently* is its own bug: a
 * subscriber whose stream has lost events cannot distinguish a quiet chain
 * from a gap in its own data, and will treat an incomplete history as
 * complete. So drops are counted and reported.
 *
 * The notice is debounced rather than sent per drop. A saturated socket drops
 * in bursts, and one notice per dropped message would add to the very
 * congestion it is reporting — and would itself be dropped. The notice is only
 * emitted once the socket has actually drained below the threshold.
 */
export function createBackpressureSender(
  ws: SendableSocket,
  options: { maxBufferedBytes?: number; noticeMs?: number } = {},
): (msg: Record<string, unknown>) => void {
  const maxBufferedBytes = options.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
  const noticeMs = options.noticeMs ?? BACKPRESSURE_NOTICE_MS;

  let droppedCount = 0;
  let noticeQueued = false;

  const isOpen = () => ws.readyState === WebSocket.OPEN;

  const flushNotice = () => {
    noticeQueued = false;
    if (droppedCount === 0 || !isOpen()) return;
    // Still saturated — the notice would be dropped too. Try again later.
    if (ws.bufferedAmount > maxBufferedBytes) {
      noticeQueued = true;
      setTimeout(flushNotice, noticeMs);
      return;
    }
    const dropped = droppedCount;
    droppedCount = 0;
    ws.send(
      JSON.stringify({
        type: "backpressure",
        payload: {
          droppedCount: dropped,
          message:
            `${dropped} message(s) were dropped because this connection could ` +
            `not keep up. Re-query the REST API to fill the gap.`,
        },
      }),
    );
  };

  return (msg: Record<string, unknown>) => {
    if (!isOpen()) return;

    if (ws.bufferedAmount > maxBufferedBytes) {
      droppedCount++;
      if (!noticeQueued) {
        noticeQueued = true;
        setTimeout(flushNotice, noticeMs);
      }
      return;
    }

    ws.send(JSON.stringify(msg));
  };
}

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
    transferAdded(contractId: String, network: Network): Transfer!
    hostFnLogAdded(contractId: String, network: Network): HostFnLog!
  }
`;

/**
 * The network one subscription streams: its own `network:` argument, else the
 * one the socket connected with. Values reaching here are already validated —
 * the argument by the schema enum, the socket's by {@link resolveSocketNetwork}
 * at upgrade time.
 */
function subscriptionNetwork(arg: string | undefined, ctx: GraphQLContext | undefined): Network {
  if (arg !== undefined) return arg.toLowerCase() as Network;
  return ctx?.network ?? "testnet";
}

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
  | GraphQLFieldResolver<unknown, GraphQLContext | undefined>
  | {
      subscribe?: GraphQLFieldResolver<unknown, GraphQLContext | undefined>;
      resolve?: GraphQLFieldResolver<unknown, GraphQLContext | undefined>;
    }
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
        subscribe: (_parent, args: { contractId?: string; network?: string }, ctx) => {
          // Both loops publish onto one emitter, so the stream must be filtered
          // by network or a subscriber gets the other chain's rows (#163).
          const net = subscriptionNetwork(args.network, ctx);
          return filterAsyncIterator<TransferEvent>(
            eventsToAsyncIterator<TransferEvent>(transferEmitter, "transfer:new"),
            (t) => t.network === net && (!args.contractId || t.contractId === args.contractId)
          );
        },
        resolve: (payload: unknown) => {
          const transfer = payload as TransferEvent;
          return {
            ...formatTransfer(transfer as unknown as Record<string, unknown>),
            displayAmount: toDisplayAmount(transfer.amount),
          };
        },
      },
      hostFnLogAdded: {
        subscribe: (_parent, args: { contractId?: string; network?: string }, ctx) => {
          const net = subscriptionNetwork(args.network, ctx);
          return filterAsyncIterator<HostFnLogEvent>(
            eventsToAsyncIterator<HostFnLogEvent>(hostFnLogEmitter, "hostfnlog:new"),
            (l) => l.network === net && (!args.contractId || l.contractId === args.contractId)
          );
        },
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

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    // `?network=` on the upgrade URL applies to every subscription on this
    // socket unless a field overrides it. Rejected here rather than per
    // subscription: a socket opened against a network this process does not
    // serve can never produce anything.
    const selection = resolveSocketNetwork(req?.url ?? "");
    if ("error" in selection) {
      ws.close(1008, selection.error);
      return;
    }
    const context: GraphQLContext = { network: selection.network };

    // One entry per active subscription id on this connection, so a
    // "complete" message or socket close can release its async iterator.
    const active = new Map<string, AsyncIterator<ExecutionResult>>();

    const send = createBackpressureSender(ws);

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

        const result = await subscribe({
          schema,
          document,
          variableValues: variables,
          contextValue: context,
        });

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
