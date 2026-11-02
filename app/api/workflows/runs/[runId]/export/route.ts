import { api } from "@/server/http/api";
import { exportMarkdown } from "@/server/workflows/outputs";

export const dynamic = "force-dynamic";

/** Markdown of the run (always available; the browser downloads or copies it). */
export const GET = api<undefined, { runId: string }>(({ user, params }) => exportMarkdown(user.id, params.runId), { cap: "work.use" });
