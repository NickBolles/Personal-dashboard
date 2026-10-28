import { z } from "zod";
import { api } from "@/server/http/api";
import { requireSmart } from "@/server/smart/store";
import { workflowSurface } from "@/server/smart/workflows";
import { WORKFLOW_KINDS } from "@/lib/jarvis-ui/types";

export const dynamic = "force-dynamic";

const body = z.object({ kind: z.enum(WORKFLOW_KINDS), ref: z.string().max(240).optional(), rebuild: z.boolean().optional() }).strict();

/** The current Jarvis-built workflow surface (morning brief, week plan, PR card); `rebuild` starts a fresh one from current data. */
export const POST = api<z.infer<typeof body>>(
  ({ user, body }) => {
    requireSmart(user);
    return workflowSurface(user, body);
  },
  { body, cap: "work.use" },
);
