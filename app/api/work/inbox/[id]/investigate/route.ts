import { NextResponse } from "next/server";
import { api } from "@/server/http/api";
import type { z } from "zod";
import { investigateSchema } from "@/lib/ai";
import { investigateEntry } from "@/server/capture";

/** Manual (re-)investigation of a capture; "Send anyway" for heuristic finance matches is audited. */
export const POST = api<z.infer<typeof investigateSchema>, { id: string }>(
  ({ user, params, body, correlationId }) => {
    const r = investigateEntry(user, params.id, body, correlationId);
    return NextResponse.json({ job: r.job }, { status: r.created ? 202 : 200, headers: { "cache-control": "no-store" } });
  },
  { capAll: ["work.use", "work.ai"], body: investigateSchema },
);
