import { z } from "zod";
import { api } from "@/server/http/api";
import { getWorkflow, saveVersion, setWorkflowStatus } from "@/server/workflows/store";
import { definitionBody } from "@/server/workflows/http";

export const dynamic = "force-dynamic";

export const GET = api<undefined, { id: string }>(({ user, params }) => getWorkflow(user.id, params.id), { cap: "work.use" });

/** Save a new immutable version. */
export const PUT = api<z.infer<typeof definitionBody>, { id: string }>(
  ({ user, params, body, correlationId }) => saveVersion({ userId: user.id, correlationId }, params.id, body.definition, body.changeNote),
  { cap: "work.use", body: definitionBody },
);

const statusBody = z.object({ status: z.enum(["draft", "active", "archived"]) }).strict();

/** Activate (imports arrive as drafts), back to draft, or archive. No delete. */
export const PATCH = api<z.infer<typeof statusBody>, { id: string }>(
  ({ user, params, body, correlationId }) => setWorkflowStatus({ userId: user.id, correlationId }, params.id, body.status),
  { cap: "work.use", body: statusBody },
);
