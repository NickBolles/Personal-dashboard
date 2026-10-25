import { api } from "@/server/http/api";
import type { z } from "zod";
import { reportPatchSchema } from "@/lib/ai";
import { getReport, patchReport } from "@/server/ai/reports";

export const dynamic = "force-dynamic";

export const GET = api<undefined, { id: string }>(({ user, params }) => getReport(user.id, params.id), { cap: "work.use" });

export const PATCH = api<z.infer<typeof reportPatchSchema>, { id: string }>(({ user, params, body }) => patchReport(user.id, params.id, body), {
  cap: "work.use",
  body: reportPatchSchema,
});
