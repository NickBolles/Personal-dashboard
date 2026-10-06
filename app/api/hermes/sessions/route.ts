import { z } from "zod";
import { api } from "@/server/http/api";
import { createSession, listSessions } from "@/integrations/hermes/service";

export const dynamic = "force-dynamic";

export const GET = api(
  async ({ req, user }) => ({
    sessions: await listSessions(user, { includeArchived: req.nextUrl.searchParams.get("archived") === "1" }),
  }),
  { cap: "hermes.chat" },
);

export const POST = api(({ body, user }) => createSession(user, body.title), {
  body: z.object({ title: z.string().max(200).optional() }),
  cap: "hermes.chat",
});
