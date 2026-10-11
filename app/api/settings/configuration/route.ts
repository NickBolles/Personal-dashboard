import { z } from "zod";
import { api, checkCsrf } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { applyConfiguration, decryptConfiguration, exportConfiguration, MAX_CONFIG_FILE_BYTES, previewConfiguration } from "@/server/config-transfer";

export const runtime = "nodejs";
const password = z.string().min(12).max(1024);
const file = z.string().max(MAX_CONFIG_FILE_BYTES);
const requestSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("export"), password, includeSecrets: z.boolean().default(false) }),
  z.strictObject({ operation: z.literal("preview"), password, file, replaceExisting: z.boolean().default(false) }),
  z.strictObject({ operation: z.literal("apply"), password, file, replaceExisting: z.boolean().default(false), revision: z.string().regex(/^[a-f0-9]{64}$/) }),
]);

/** Bound the stream itself, including requests with absent/forged Content-Length. */
async function readRequest(req: Request) {
  const limit = 192 * 1024;
  if (Number(req.headers.get("content-length")) > limit) throw new HttpError(413, "too_large", "Configuration request is too large");
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel();
          throw new HttpError(413, "too_large", "Configuration request is too large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  try {
    return requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    throw new HttpError(400, "invalid_configuration", "Invalid configuration request");
  }
}

// POST even for export/preview: password never appears in a URL. Admin checked before reading bodies/KDF.
export const POST = api(
  async ({ req }) => {
    checkCsrf(req); // Explicitly require CSRF on this sensitive endpoint, including device-token callers.
    const body = await readRequest(req);
    try {
      if (body.operation === "export") return { file: await exportConfiguration(body.password, body.includeSecrets) };
      const configuration = await decryptConfiguration(body.file, body.password);
      if (body.operation === "preview") return previewConfiguration(configuration, body.replaceExisting);
      return applyConfiguration(configuration, body.replaceExisting, body.revision);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      // Never let crypto/storage errors or imported data reach the generic logger.
      throw new HttpError(400, "configuration_failed", "Configuration operation failed. No changes were applied.");
    }
  },
  { cap: "admin" },
);
