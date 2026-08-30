/**
 * Per-request network selection (#163).
 *
 * Storage, RPC and the indexer loops are already network-aware (#159–#161):
 * every `db.ts` function takes an optional `network`, and omitting it means
 * "whatever `STELLAR_NETWORK` says". The API had no way to say anything else,
 * so a process indexing both chains could only ever serve one of them.
 *
 * This middleware resolves the network once per request and hangs it off
 * `req.network`. Handlers pass that straight through to the data layer instead
 * of each re-parsing the query string — one parse, one validation, one error
 * message, and no route that quietly forgets to look.
 */
import type { Request, Response, NextFunction } from "express";
import { currentNetwork, enabledNetworks, isNetwork, NETWORKS, type Network } from "../network";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * The network this request reads from. Always set by
       * {@link networkMiddleware} before any route runs.
       */
      network?: Network;
    }
  }
}

/** Header form of the selector, for clients that would rather not touch the query string. */
export const NETWORK_HEADER = "x-network";

/**
 * Read the raw selector off a request: `?network=` first, then `X-Network`.
 *
 * Query wins over header so a link someone can paste and share beats a default
 * their HTTP client set for them.
 */
function rawSelector(req: Request): string | undefined {
  const fromQuery = req.query?.network;
  const value = Array.isArray(fromQuery) ? fromQuery[0] : fromQuery;
  if (typeof value === "string" && value.trim() !== "") return value;

  const fromHeader = req.headers?.[NETWORK_HEADER];
  const header = Array.isArray(fromHeader) ? fromHeader[0] : fromHeader;
  if (typeof header === "string" && header.trim() !== "") return header;

  return undefined;
}

/**
 * Resolve `?network=` / `X-Network` into `req.network`, or answer 400.
 *
 * Absent selector → {@link currentNetwork}, which is exactly what every route
 * read before this existed, so existing callers see no change.
 *
 * Two distinct rejections, because they need different fixes:
 *   - not a network at all ("mainet") → the caller has a typo;
 *   - a real network this process does not serve → the caller wants a
 *     deployment that indexes it, and the message says which ones this one has.
 *
 * Returning empty results for an un-indexed network would be the worse answer:
 * "no transfers" and "this process has never looked at that chain" are not the
 * same statement, and silently conflating them is how a dashboard ends up
 * confidently showing zero.
 */
export function networkMiddleware(req: Request, res: Response, next: NextFunction): void {
  const raw = rawSelector(req);

  if (raw === undefined) {
    req.network = currentNetwork();
    next();
    return;
  }

  const normalised = raw.trim().toLowerCase();

  if (!isNetwork(normalised)) {
    res.status(400).json({
      error: `Invalid network: "${raw}". Valid values: ${NETWORKS.join(", ")}.`,
    });
    return;
  }

  const enabled = enabledNetworks();
  if (!enabled.includes(normalised)) {
    res.status(400).json({
      error:
        `Network "${normalised}" is not enabled on this deployment. ` +
        `Enabled networks: ${enabled.join(", ")}.`,
    });
    return;
  }

  req.network = normalised;
  next();
}

/**
 * The network for a request, for handlers that would rather not repeat the
 * `?? currentNetwork()` fallback. The fallback only fires if a router is
 * mounted without {@link networkMiddleware} ahead of it.
 */
export function requestNetwork(req: Request): Network {
  return req.network ?? currentNetwork();
}
