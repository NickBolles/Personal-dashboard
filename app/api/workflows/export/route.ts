import { api } from "@/server/http/api";
import { exportWorkflows } from "@/server/workflows/store";

export const dynamic = "force-dynamic";

/** Export one (`?id=`) or all workflows as `jarvis-workflow@1` definitions. */
export const GET = api(
  ({ user, req }) => {
    const id = req.nextUrl.searchParams.get("id");
    return exportWorkflows(user.id, id ? [id] : undefined);
  },
  { cap: "work.use" },
);
