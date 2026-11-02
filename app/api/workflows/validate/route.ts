import { z } from "zod";
import { api } from "@/server/http/api";
import { validateDraft } from "@/server/workflows/store";

export const dynamic = "force-dynamic";

const body = z.object({ definition: z.unknown() }).strict();

/** Builder dry run: validator issues (incl. Finance/area checks) without saving anything. */
export const POST = api<z.infer<typeof body>>(({ user, body }) => validateDraft(user.id, body.definition), { cap: "work.use", body });
