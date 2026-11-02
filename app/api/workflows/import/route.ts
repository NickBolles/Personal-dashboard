import { z } from "zod";
import { api } from "@/server/http/api";
import { importWorkflows } from "@/server/workflows/store";

export const dynamic = "force-dynamic";

const body = z.object({ data: z.unknown() }).strict();

/** Import one `jarvis-workflow@1` definition or an export bundle; each lands as a draft. */
export const POST = api<z.infer<typeof body>>(
  ({ user, body, correlationId }) => ({ results: importWorkflows({ userId: user.id, correlationId }, body.data) }),
  {
    cap: "work.use",
    body,
  },
);
