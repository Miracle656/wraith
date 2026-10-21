import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { withRequestId } from '../logger';

const HEADER = 'x-request-id';

export interface RequestWithId extends Request {
  requestId: string;
}

/**
 * Assigns a request id to every inbound request, echoes it back on the
 * response, and runs the rest of the request inside an AsyncLocalStorage
 * context so the logger can attach it to every line - including lines
 * emitted from the provider client.
 *
 * If the client already sent an x-request-id we honour it, so a trace can
 * span multiple services. Otherwise we mint a new one.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.headers[HEADER];
  const id =
    typeof inbound === 'string' && inbound.trim().length > 0
      ? inbound.trim().slice(0, 128)
      : randomUUID();

  (req as RequestWithId).requestId = id;
  res.setHeader(HEADER, id);

  withRequestId(id, () => {
    next();
  });
}

export const REQUEST_ID_HEADER = HEADER;
