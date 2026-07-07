/** Error thrown by a hook when the Wraith API responds with a non-2xx status. */
export class WraithError extends Error {
  /** HTTP status code of the failed response. */
  readonly status: number;
  /** The parsed error body the API returned, if any. */
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    const detail =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : undefined;
    super(detail ?? `Wraith API request failed with status ${status}`);
    this.name = "WraithError";
    this.status = status;
    this.body = body;
  }
}
