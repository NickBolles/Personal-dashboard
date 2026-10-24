import { api } from "@/server/http/api";
import type { z } from "zod";
import { githubConnectionUpdateSchema } from "@/lib/github";
import { deleteGithubConnection, updateGithubConnection } from "@/server/work/github-connections";

export const PATCH = api<z.infer<typeof githubConnectionUpdateSchema>, { id: string }>(
  ({ user, params, body, correlationId }) => ({ connection: updateGithubConnection(user, params.id, body, correlationId) }),
  { cap: "admin", body: githubConnectionUpdateSchema },
);

export const DELETE = api<undefined, { id: string }>(({ user, params, correlationId }) => deleteGithubConnection(user, params.id, correlationId), {
  cap: "admin",
});
