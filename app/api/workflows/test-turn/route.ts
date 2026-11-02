import { z } from "zod";
import { api } from "@/server/http/api";
import { testTurn, testTurnBody } from "@/server/workflows/test-turn";

export const dynamic = "force-dynamic";

/** Builder "Test a turn": sandbox run against the draft; discarded (nothing persisted). */
export const POST = api<z.infer<typeof testTurnBody>>(({ user, body }) => testTurn(user, body), {
  capAll: ["work.use", "work.ai"],
  body: testTurnBody,
});
