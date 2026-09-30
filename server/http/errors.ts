/** Error raised by adapters when an upstream call fails. Safe to show to the user. */
export class UpstreamError extends Error {
  constructor(
    public source: string,
    public kind: "unreachable" | "unauthorized" | "not_found" | "bad_response" | "timeout" | "conflict" | "unsupported",
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
  ) {
    super(message);
  }
}
