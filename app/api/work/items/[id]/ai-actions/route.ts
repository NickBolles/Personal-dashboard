import { NextResponse } from "next/server";
import { api } from "@/server/http/api";
import type { z } from "zod";
import { aiActionSchema } from "@/lib/ai";
import { contextAllowed } from "@/server/context";
import { isConfigured } from "@/integrations/store";
import { HttpError } from "@/server/http/errors";
import { enqueue } from "@/server/ai/jobs";
import { kickRunner } from "@/server/ai/runner";
import { getDetail } from "@/server/work/store";

/** Start an AI action on a work item (202 new job, 200 an identical active job). */
export const POST = api<z.infer<typeof aiActionSchema>, { id: string }>(
  ({ user, params, body, correlationId }) => {
    getDetail(user.id, params.id); // ownership (404)
    if (!isConfigured("hermes")) throw new HttpError(409, "hermes_unavailable", "Hermes isn't configured");
    const contextSources = (body.contextSources ?? []).filter((s) => contextAllowed(user, s));
    const r = enqueue({
      userId: user.id,
      kind: body.action,
      subjectType: "work_item",
      subjectId: params.id,
      clientKey: body.clientKey,
      model: body.model ?? null,
      budgetOverride: body.budgetOverride,
      params: {
        ...(body.instructions ? { instructions: body.instructions } : {}),
        ...(contextSources.length ? { contextSources } : {}),
        ...(body.draftKind ? { draftKind: body.draftKind } : {}),
        ...(body.durationHint ? { durationHint: body.durationHint } : {}),
        ...(body.deep ? { deep: true } : {}),
      },
      correlationId,
    });
    kickRunner();
    return NextResponse.json({ job: r.job }, { status: r.created ? 202 : 200, headers: { "cache-control": "no-store" } });
  },
  { capAll: ["work.use", "work.ai"], body: aiActionSchema },
);
