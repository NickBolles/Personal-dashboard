import { mergeExecutionRecords, type ExecutionRecord } from "@/lib/chat-execution";
import { redactToolText } from "@/lib/tool-presentation";

/** Relationship context, never a lossy parent/child merge. */
export type PresentedExecution = { key: string; members: ExecutionRecord[] };
export function executionTitle(record: Pick<ExecutionRecord, "title" | "source">): string {
  const title = typeof record.title === "string" ? redactToolText(record.title).trim() : "";
  if (!title) return record.source === "registered_run" ? "Registered run" : "Execution details unavailable";
  const sentences = title
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const candidate = /^(?:act as|you are)\b/i.test(sentences[0] ?? "") ? (sentences[1] ?? sentences[0]) : sentences[0];
  const cleaned = (candidate ?? "").replace(/\s+/g, " ").replace(/(?:\/[^\s]+){2,}/g, "local path");
  return cleaned.length <= 96 ? cleaned : `${cleaned.slice(0, 93).trimEnd()}…`;
}

/** Full delegation identity only. Bare handles, titles and host paths never prove a relationship. */
export function presentExecutions(records: readonly ExecutionRecord[]): PresentedExecution[] {
  const unique = mergeExecutionRecords([...records]);
  const registrations = unique.filter((r) => r.source === "registered_run" && r.delegationId);
  const byKey = new Map<string, PresentedExecution>();
  for (const record of unique) {
    // MCP registration may name `delegation:subagent`; transcript rows store those separately.
    const compound = record.delegationId && record.subagentId ? `${record.delegationId}:${record.subagentId}` : null;
    const parents = compound ? registrations.filter((r) => r.delegationId === compound) : [];
    const identity = parents.length === 1 ? compound : record.delegationId;
    const groupKey = identity ? `delegation:${identity}` : `record:${record.key}`;
    const group = byKey.get(groupKey) ?? { key: groupKey, members: [] };
    group.members.push(record);
    byKey.set(groupKey, group);
  }
  return [...byKey.values()];
}
