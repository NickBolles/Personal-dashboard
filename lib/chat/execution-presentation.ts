import type { ExecutionRecord } from "@/lib/chat-execution";

/** Presentation-only group: relationship context, never a lossy record merge. */
export type PresentedExecution = { key: string; members: ExecutionRecord[] };
const text = (value: unknown) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");

/** First useful stored goal sentence, never a filesystem-path-heavy prompt dump. */
export function executionTitle(record: Pick<ExecutionRecord, "title" | "source">): string {
  const title = text(record.title);
  if (!title) return record.source === "registered_run" ? "Registered run" : "Execution details unavailable";
  const sentences = title.split(/(?<=[.!?])\s|\n/).filter(Boolean);
  const candidate = /^(?:act as|you are)\b/i.test(sentences[0] ?? "") ? (sentences[1] ?? sentences[0]) : sentences[0];
  const cleaned = text(candidate).replace(/(?:\/[^\s]+){2,}/g, "local path");
  return cleaned.length <= 96 ? cleaned : `${cleaned.slice(0, 93).trimEnd()}…`;
}

/**
 * Correlate only records that name the same complete delegation batch. A bare subagent handle is reused by
 * different batches, so it is never a key. Individual records remain intact in `members`.
 */
export function presentExecutions(records: readonly ExecutionRecord[]): PresentedExecution[] {
  const byKey = new Map<string, PresentedExecution>();
  for (const record of records) {
    const groupKey = record.delegationId && record.delegationId.length > 0 ? `delegation:${record.delegationId}` : `record:${record.key}`;
    const group = byKey.get(groupKey) ?? { key: groupKey, members: [] };
    group.members.push(record);
    byKey.set(groupKey, group);
  }
  return [...byKey.values()];
}
