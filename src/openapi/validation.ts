import type { Response } from "express";
import type { ZodTypeAny } from "zod";

export function sendValidationError(res: Response, error: { issues: Array<{ message: string }> }): void {
  const message = error.issues[0]?.message ?? "Invalid request";
  res.status(400).json({ error: message });
}

export function parseOr400<T extends ZodTypeAny>(
  schema: T,
  input: unknown,
  res: Response,
): import("zod").infer<T> | null {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return null;
  }
  return parsed.data;
}
