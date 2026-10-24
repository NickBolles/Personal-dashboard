import { api } from "@/server/http/api";
import type { z } from "zod";
import { dependencySchema } from "@/lib/work";
import { addDependency } from "@/server/work/store";

/** This item depends on (is blocked by) another of your items. Cycle-safe. */
export const POST = api<z.infer<typeof dependencySchema>, { id: string }>(
  ({ user, params, body, correlationId }) => ({ dependency: addDependency(user, params.id, body.dependsOnId, correlationId) }),
  { cap: "work.use", body: dependencySchema },
);
