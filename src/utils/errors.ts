import { randomUUID } from 'crypto';

// Errors that are safe to show the caller verbatim (4xx, deliberate)
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export function newCorrelationId(): string {
  return randomUUID();
}