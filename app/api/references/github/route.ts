import { api } from "@/server/http/api";
import { githubRefOptions } from "@/server/references";

export const dynamic = "force-dynamic";

/** The composer's `#` picker: PRs/issues in `repo` (read-only GitHub search) plus your linked ones. */
export const GET = api(
  ({ req, user }) => {
    const repo = req.nextUrl.searchParams.get("repo")?.trim() || null;
    return githubRefOptions(user, repo && /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repo) ? repo : null, req.nextUrl.searchParams.get("q") ?? "");
  },
  { cap: "hermes.chat" },
);
