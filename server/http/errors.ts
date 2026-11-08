/** Error raised by adapters when an upstream call fails. Safe to show to the user. */
export class UpstreamError extends Error {
  constructor(
    public source: string,
    public kind: "unreachable" | "unauthorized" | "not_found" | "bad_response" | "timeout" | "conflict" | "unsupported" | "busy",
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    /** Safe, user-visible extra context (e.g. the upstream's own reason), sent as the response `detail`. */
    public detail?: unknown,
  ) {
    super(message);
  }
}
