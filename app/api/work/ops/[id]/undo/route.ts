import { api } from "@/server/http/api";
import { undoOp } from "@/server/work/store";

/** Undo a structural operation: only the item's latest one, once, within the window (server/work/undo-rules.ts). */
export const POST = api<undefined, { id: string }>(({ user, params, correlationId }) => undoOp(user, params.id, correlationId), { cap: "work.use" });
