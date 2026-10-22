import { api } from "@/server/http/api";
import type { z } from "zod";
import { linkSchema } from "@/lib/work";
import { addLink } from "@/server/work/store";

export const POST = api<z.infer<typeof linkSchema>, { id: string }>(
  async ({ user, params, body, correlationId }) => ({ link: await addLink(user, params.id, body, correlationId) }),
  {
    cap: "work.use",
    body: linkSchema,
  },
);
