import { z } from "zod";
import { api } from "@/server/http/api";
import { forgetPlace, renamePlace } from "@/server/workflows/runs";

export const dynamic = "force-dynamic";

const noUrl = (s: string) => !/[<>]|https?:\/\//i.test(s);
const body = z.object({ label: z.string().trim().min(1).max(80).refine(noUrl) }).strict();

/** Rename (Settings → Saved places). */
export const PATCH = api<z.infer<typeof body>, { placeId: string }>(
  ({ user, params, body, correlationId }) => renamePlace({ userId: user.id, correlationId }, params.placeId, body.label),
  { cap: "work.use", body },
);

export const DELETE = api<undefined, { placeId: string }>(
  ({ user, params, correlationId }) => forgetPlace({ userId: user.id, correlationId }, params.placeId),
  { cap: "work.use" },
);
