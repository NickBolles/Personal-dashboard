import { NextResponse } from "next/server";
import type { z } from "zod";
import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { isConfigured } from "@/integrations/store";
import { fileSuggestSchema, type AiFilingState, type AiFilingSuggestion } from "@/lib/ai";
import { enqueue, listJobs } from "@/server/ai/jobs";
import { financeGuard } from "@/server/ai/rules";
import { fileSuggestionsKey, kickRunner } from "@/server/ai/runner";
import { getSetting } from "@/server/settings";
import { unfiledConversations } from "@/server/work/conversations";

export const dynamic = "force-dynamic";

const MAX = 15;

type Stored = { jobId: string; at: string; suggestions: AiFilingSuggestion[]; excluded?: number };

/** The latest AI filing suggestions for your unfiled conversations, and the job that makes them. */
export const GET = api(
  ({ user }): AiFilingState => {
    const stored = getSetting<Stored>(fileSuggestionsKey(user.id));
    const job = listJobs(user.id, { subject: user.id, limit: 1 }).find((j) => j.kind === "file") ?? null;
    return { job, suggestions: stored?.suggestions ?? [], at: stored?.at ?? null, excluded: stored?.excluded ?? 0 };
  },
  { capAll: ["work.use", "work.ai", "hermes.chat"] },
);

/**
 * "Suggest with AI" (on demand): one triage-tier job for up to 15 unfiled
 * conversations, on the shared AI budget. Titles are read server-side (never
 * from the request) and each is screened: finance- or credential-looking
 * titles are left out, and AI-excluded areas (Finance) are never offered as
 * destinations. 202 = queued, 200 = an identical job is already running.
 */
export const POST = api<z.infer<typeof fileSuggestSchema>>(
  async ({ user, body, correlationId }) => {
    if (!isConfigured("hermes")) throw new HttpError(409, "hermes_unavailable", "Hermes isn't configured");
    const list = await unfiledConversations(user, { includeMisc: true });
    const screened = list.conversations.filter((c) => financeGuard({ kind: "file", area: null, text: c.title }).ok);
    const conversations = screened.slice(0, MAX).map((c) => ({ id: c.id.slice(0, 120), title: c.title.slice(0, 100) }));
    if (!conversations.length) throw new HttpError(409, "nothing_to_file", "Nothing to suggest: no unfiled conversations can go to AI.");
    const r = enqueue({
      userId: user.id,
      kind: "file",
      subjectType: "conversations",
      subjectId: user.id,
      clientKey: body.clientKey,
      params: { conversations },
      correlationId,
    });
    kickRunner();
    return NextResponse.json(
      { job: r.job, asked: conversations.length, excluded: list.conversations.length - screened.length },
      { status: r.created ? 202 : 200, headers: { "cache-control": "no-store" } },
    );
  },
  { capAll: ["work.use", "work.ai", "hermes.chat"], body: fileSuggestSchema },
);
