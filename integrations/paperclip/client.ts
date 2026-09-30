import "server-only";
import { z } from "zod";
import { upstream } from "@/server/http/fetch";
import { UpstreamError } from "@/server/http/errors";
import { resolveIntegration } from "@/integrations/store";

/** Paperclip DTOs (paperclipai/paperclip @ f38b5693). Lenient: many optional fields exist upstream. */

export const PAPERCLIP_STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"] as const;
export const TERMINAL = ["done", "cancelled"];

const relationSummary = z
  .object({
    id: z.string(),
    identifier: z.string().nullish(),
    title: z.string(),
    status: z.string(),
    priority: z.string().nullish(),
    assigneeAgentId: z.string().nullish(),
    assigneeUserId: z.string().nullish(),
  })
  .passthrough();

export const issueSchema = z
  .object({
    id: z.string(),
    companyId: z.string().optional(),
    identifier: z.string().nullish(),
    issueNumber: z.number().nullish(),
    title: z.string(),
    description: z.string().nullish(),
    status: z.string(),
    priority: z.string().nullish(),
    parentId: z.string().nullish(),
    projectId: z.string().nullish(),
    assigneeAgentId: z.string().nullish(),
    assigneeUserId: z.string().nullish(),
    blockedBy: z.array(relationSummary).optional(),
    blocks: z.array(relationSummary).optional(),
    ancestors: z.array(relationSummary.partial({ status: true })).optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    deduplicated: z.boolean().optional(),
  })
  .passthrough();
export type PaperclipIssue = z.infer<typeof issueSchema>;

export const companySchema = z.object({ id: z.string(), name: z.string(), issuePrefix: z.string().nullish(), status: z.string().optional() }).passthrough();

export type PaperclipConn = { baseUrl: string; apiKey?: string; companyId?: string; uiUrl: string; issuePrefix?: string };

export function paperclipConn(): PaperclipConn {
  const r = resolveIntegration("paperclip");
  if (!r.config.baseUrl) throw new UpstreamError("Paperclip", "unsupported", "Paperclip is not configured");
  return {
    baseUrl: r.config.baseUrl,
    apiKey: r.secrets.apiKey,
    companyId: r.config.companyId || undefined,
    uiUrl: (r.config.uiUrl || r.config.baseUrl).replace(/\/$/, ""),
    issuePrefix: r.config.issuePrefix || undefined,
  };
}

function req<T>(c: PaperclipConn, path: string, init: { method?: string; body?: unknown; query?: Record<string, string | number | boolean | undefined> } = {}) {
  return upstream<T>({
    source: "Paperclip",
    baseUrl: c.baseUrl,
    path: `/api${path}`,
    method: init.method,
    body: init.body,
    query: init.query,
    headers: c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {},
  });
}

let companyCache: { key: string; id: string; prefix?: string } | undefined;

export async function resolveCompany(c: PaperclipConn) {
  const key = `${c.baseUrl}|${c.companyId ?? ""}`;
  if (companyCache?.key === key) return companyCache;
  const companies = z.array(companySchema).parse(await req(c, "/companies", { query: { scope: "accessible" } }));
  const company = c.companyId ? companies.find((x) => x.id === c.companyId) : companies[0];
  if (!company) throw new UpstreamError("Paperclip", "not_found", "No accessible Paperclip company");
  companyCache = { key, id: company.id, prefix: c.issuePrefix ?? company.issuePrefix ?? undefined };
  return companyCache;
}

export const PaperclipClient = {
  health: (c: PaperclipConn) => req(c, "/health"),
  me: (c: PaperclipConn) => req<{ userId?: string; user?: { name?: string } }>(c, "/cli-auth/me"),
  companies: async (c: PaperclipConn) => z.array(companySchema).parse(await req(c, "/companies", { query: { scope: "accessible" } })),
  issues: async (c: PaperclipConn, q: { status?: string[]; parentId?: string; q?: string; assignee?: "me"; limit?: number }) => {
    const company = await resolveCompany(c);
    return z.array(issueSchema).parse(
      await req(c, `/companies/${company.id}/issues`, {
        query: {
          status: q.status?.join(","),
          parentId: q.parentId,
          q: q.q,
          assigneeUserId: q.assignee,
          includeBlockedBy: true,
          limit: q.limit ?? 200,
        },
      }),
    );
  },
  issue: async (c: PaperclipConn, idOrIdentifier: string) => issueSchema.parse(await req(c, `/issues/${encodeURIComponent(idOrIdentifier)}`)),
  createIssue: async (
    c: PaperclipConn,
    body: { title: string; description?: string; parentId?: string; projectId?: string; priority?: string; idempotencyKey: string },
  ) => {
    const company = await resolveCompany(c);
    return issueSchema.parse(await req(c, `/companies/${company.id}/issues`, { method: "POST", body }));
  },
  comment: (c: PaperclipConn, issueId: string, body: string, clientRequestId: string) =>
    req(c, `/issues/${encodeURIComponent(issueId)}/comments`, { method: "POST", body: { body, clientRequestId } }),
};

export function issueUrl(c: PaperclipConn, prefix: string | undefined, issue: Pick<PaperclipIssue, "id" | "identifier">) {
  const key = issue.identifier ?? issue.id;
  return prefix ? `${c.uiUrl}/${prefix}/issues/${key}` : `${c.uiUrl}/issues/${key}`;
}

export function __resetCompanyCache() {
  companyCache = undefined;
}
