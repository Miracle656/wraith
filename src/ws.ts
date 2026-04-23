import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "http";
import { transferEmitter, TransferEvent } from "./events";
import { toDisplayAmount } from "./api";

// Matches /subscribe/<Stellar address>
const SUBSCRIBE_RE = /^\/subscribe\/([A-Z0-9]+)$/;

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

    const handler = (transfer: TransferEvent) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (transfer.toAddress !== address && transfer.fromAddress !== address) return;
      ws.send(JSON.stringify(buildPayload(transfer)));
    };

    transferEmitter.on("transfer:new", handler);

    const cleanup = () => transferEmitter.off("transfer:new", handler);
    ws.on("close", cleanup);
    ws.on("error", cleanup);
  });
}
