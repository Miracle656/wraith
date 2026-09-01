import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "http";
import { transferEmitter, TransferEvent } from "./events";
import { toDisplayAmount } from "./api";
import { currentNetwork, enabledNetworks, isNetwork, NETWORKS, type Network } from "./network";

// Matches /subscribe/<Stellar address>, ignoring any query string (#163).
const SUBSCRIBE_RE = /^\/subscribe\/([A-Z0-9]+)(?:\?.*)?$/;

/**
 * Resolve `?network=` on the upgrade URL.
 *
 * Returns the selected network, or a rejection reason to close the socket
 * with. A subscriber cannot be told "your filter was invalid" after the fact —
 * they would just sit on a silent socket — so an unusable selector closes the
 * connection with a message instead of quietly defaulting.
 */
export function resolveSocketNetwork(url: string): { network: Network } | { error: string } {
  const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  const raw = new URLSearchParams(query).get("network");
  if (raw === null || raw.trim() === "") return { network: currentNetwork() };

  const normalised = raw.trim().toLowerCase();
  if (!isNetwork(normalised)) {
    return { error: `Invalid network: "${raw}". Valid values: ${NETWORKS.join(", ")}.` };
  }

  const enabled = enabledNetworks();
  if (!enabled.includes(normalised)) {
    return {
      error: `Network "${normalised}" is not enabled on this deployment. Enabled networks: ${enabled.join(", ")}.`,
    };
  }

  return { network: normalised };
}

type WsPayload = TransferEvent & { displayAmount: string };

function buildPayload(t: TransferEvent): WsPayload {
  return { ...t, displayAmount: toDisplayAmount(t.amount) };
}

/**
 * Attach a WebSocket server to an existing HTTP server.
 *
 * Clients connect to:  ws://host/subscribe/:address
 *
 * The server pushes a JSON-serialised transfer payload whenever a new
 * transfer is indexed where `address` matches either sender or recipient.
 * Each handler is bound to the specific socket and removed on close/error
 * so there are no dangling listeners.
 */
export function attachWebSocketServer(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = req.url ?? "";
    // GraphQL subscriptions own /graphql/* upgrades — leave those to
    // attachGraphQLSubscriptions() rather than 404'ing them here.
    if (url.startsWith("/graphql/")) return;
    if (!SUBSCRIBE_RE.test(url)) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const match = (req.url ?? "").match(SUBSCRIBE_RE);
    // Guaranteed by the upgrade guard, but required to satisfy TS
    if (!match) {
      ws.close(1008, "Invalid path");
      return;
    }
    const address = match[1];

    const selection = resolveSocketNetwork(req.url ?? "");
    if ("error" in selection) {
      // 1008 = policy violation, the closest close code for a bad parameter.
      ws.close(1008, selection.error);
      return;
    }
    const network = selection.network;

    const handler = (transfer: TransferEvent) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      // A process indexing both chains emits both onto the same emitter, so a
      // subscriber that asked for one must not be handed the other.
      if (transfer.network !== network) return;
      if (transfer.toAddress !== address && transfer.fromAddress !== address) return;
      ws.send(JSON.stringify(buildPayload(transfer)));
    };

    transferEmitter.on("transfer:new", handler);

    const cleanup = () => transferEmitter.off("transfer:new", handler);
    ws.on("close", cleanup);
    ws.on("error", cleanup);
  });
}
