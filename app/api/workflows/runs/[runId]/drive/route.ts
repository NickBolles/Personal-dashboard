import { z } from "zod";
import { api } from "@/server/http/api";
import { drivePlan, driveSaveBody, saveRunToDrive } from "@/server/workflows/outputs";

export const dynamic = "force-dynamic";

/** #141: the exact Drive destination + file name the confirm sheet shows. */
export const GET = api<undefined, { runId: string }>(({ user, params }) => drivePlan(user.id, params.runId), { cap: "admin" });

/** Confirmed write: save the run's Markdown to Google Drive (path + name must match the confirm sheet). */
export const POST = api<z.infer<typeof driveSaveBody>, { runId: string }>(
  ({ user, params, body, correlationId }) => saveRunToDrive({ userId: user.id, correlationId }, params.runId, body),
  { cap: "admin", body: driveSaveBody },
);
