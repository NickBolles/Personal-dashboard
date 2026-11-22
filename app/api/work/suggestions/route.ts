import { z } from "zod";
import { api } from "@/server/http/api";
import { listSuggestions } from "@/server/work/suggestions";

export const dynamic = "force-dynamic";

const query = z.object({ scope: z.string().min(1).max(64).default("all") });

/** Suggestions to draw: one per channel ("all"), or the one for a channel. Reading them never calls a model. */
export const GET = api(
  ({ user, req }) => {
    const { scope } = query.parse(Object.fromEntries(new URL(req.url).searchParams));
    return { suggestions: listSuggestions(user, scope) };
  },
  { cap: "work.use" },
);
