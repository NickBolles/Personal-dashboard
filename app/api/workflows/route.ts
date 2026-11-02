import { api } from "@/server/http/api";
import { BUILT_IN_WORKFLOWS, createWorkflow, listWorkflows } from "@/server/workflows/store";
import { definitionBody } from "@/server/workflows/http";

export const dynamic = "force-dynamic";

/** Gallery: your workflows (drafts + active) and the read-only built-ins. */
export const GET = api(
  ({ user, req }) => ({
    workflows: listWorkflows(user.id, { includeArchived: req.nextUrl.searchParams.get("archived") === "1" }),
    builtIns: BUILT_IN_WORKFLOWS,
  }),
  {
    cap: "work.use",
  },
);

/** Create from a `jarvis-workflow@1` definition; always starts as a draft. */
export const POST = api(({ user, body, correlationId }) => createWorkflow({ userId: user.id, correlationId }, body.definition, { source: "create" }), {
  cap: "work.use",
  body: definitionBody,
});
