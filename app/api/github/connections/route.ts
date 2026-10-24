import { api } from "@/server/http/api";
import type { z } from "zod";
import { githubConnectionCreateSchema } from "@/lib/github";
import { createGithubConnection } from "@/server/work/github-connections";
import { startWorkGithubPoller } from "@/server/work/github-poller";

/** Add a read-only token for one GitHub owner. The response never contains the token. */
export const POST = api<z.infer<typeof githubConnectionCreateSchema>>(
  ({ user, body, correlationId }) => {
    const connection = createGithubConnection(user, body, correlationId);
    startWorkGithubPoller();
    return { connection };
  },
  { cap: "admin", body: githubConnectionCreateSchema },
);
