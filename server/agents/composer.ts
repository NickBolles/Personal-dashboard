import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { resolveAgentForNode } from "./routing";
import type { AgentResolution } from "@/lib/agents";
import { NODE_CTX_PREFIX, type ComposerNode } from "@/lib/composer-target";

/** One of your own work items (an area, project or item), with its path from the area down. Null if it isn't yours. */
export function composerNode(userId: string, nodeId: string): ComposerNode | null {
  const db = getDb();
  const path: { id: string; title: string; kind: string }[] = [];
  let id: string | null = nodeId;
  for (let n = 0; id && n < 100; n++) {
    const row: { id: string; title: string; kind: string; parentId: string | null } | undefined = db
      .select({ id: schema.workItems.id, title: schema.workItems.title, kind: schema.workItems.kind, parentId: schema.workItems.parentId })
      .from(schema.workItems)
      .where(and(eq(schema.workItems.id, id), eq(schema.workItems.userId, userId)))
      .get();
    if (!row) break;
    path.unshift({ id: row.id, title: row.title, kind: row.kind });
    id = row.parentId;
  }
  const self = path.at(-1);
  if (!self || self.id !== nodeId) return null;
  return { id: self.id, title: self.title, kind: self.kind, path: path.map((p) => p.title), areaId: path[0]!.id, areaTitle: path[0]!.title };
}

/** The global composer's target for `nodeId`: who answers there, and where the question is filed. */
export function composerTarget(userId: string, nodeId: string | null): { node: ComposerNode | null; agent: AgentResolution } {
  const node = nodeId ? composerNode(userId, nodeId) : null;
  return { node, agent: resolveAgentForNode(userId, node?.id ?? null) };
}

const MAX_CHILDREN = 12;

/**
 * Context block for a question asked from an area/project/item page (`@ctx:node:<id>`): its title, path,
 * summary/next action and its open children. Only your own items; nothing for an id that isn't yours.
 */
export function nodeContextBlock(userId: string, nodeId: string): string {
  const node = composerNode(userId, nodeId);
  if (!node) return "";
  const db = getDb();
  const row = db
    .select({ summary: schema.workItems.summary, nextAction: schema.workItems.nextAction, status: schema.workItems.status })
    .from(schema.workItems)
    .where(and(eq(schema.workItems.id, nodeId), eq(schema.workItems.userId, userId)))
    .get();
  const kids = db
    .select({ title: schema.workItems.title, kind: schema.workItems.kind, status: schema.workItems.status, nextAction: schema.workItems.nextAction })
    .from(schema.workItems)
    .where(and(eq(schema.workItems.parentId, nodeId), eq(schema.workItems.userId, userId), eq(schema.workItems.archived, false)))
    .orderBy(asc(schema.workItems.sortOrder))
    .all()
    .filter((k) => k.kind !== "conversation" && k.status !== "done" && k.status !== "dropped");
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const lines = [
    `Asked from Jarvis ${node.kind}: ${node.path.join(" › ")}`,
    row?.status ? `Status: ${row.status}` : "",
    row?.summary ? `Summary: ${clip(row.summary, 600)}` : "",
    row?.nextAction ? `Next action: ${clip(row.nextAction, 200)}` : "",
    kids.length
      ? `Open items (${kids.length}):\n${kids
          .slice(0, MAX_CHILDREN)
          .map((k) => `- ${clip(k.title, 120)} (${k.kind}, ${k.status})${k.nextAction ? ` — next: ${clip(k.nextAction, 100)}` : ""}`)
          .join("\n")}${kids.length > MAX_CHILDREN ? `\n- …and ${kids.length - MAX_CHILDREN} more` : ""}`
      : "",
  ];
  return lines.filter(Boolean).join("\n");
}

export { NODE_CTX_PREFIX };
