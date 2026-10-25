import { HttpError } from "./errors";

/**
 * Read a request body, refusing it once it passes `max` bytes. Counts bytes
 * while streaming, so a chunked upload with no Content-Length can't make us
 * buffer gigabytes before the size check.
 */
export async function readBodyCapped(req: Request, max: number, message = "Request body too large"): Promise<Buffer> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > max) throw new HttpError(413, "too_large", message);
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, "too_large", message);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}
