import type { ExecutionRecord } from "@/lib/chat-execution";

/** Presentation-only grouping. Records are combined only by a durable execution identity, never a similar title. */
export type PresentedExecution = {
  key: string;
  record: ExecutionRecord;
  members: ExecutionRecord[];
};

const text = (value: string | null | undefined) => value?.replace(/\s+/g, " ").trim() ?? "";

/** Keep the stored wording, but give an instruction-shaped brief a readable, bounded heading. */
export function executionTitle(record: Pick<ExecutionRecord, "title" | "source">): string {
  const title = text(record.title);
  if (!title) return record.source === "registered_run" ? "Registered run" : "Execution details unavailable";
  const sentences = title.split(/(?<=[.!?])\s|\n/).filter(Boolean);
  const first = sentences[0] ?? title;
  const withoutRole = /^(?:act as|you are)\b/i.test(first) ? sentences.slice(1).join(" ") || first : first;
  const candidate = withoutRole || first;
  return candidate.length <= 96 ? candidate : `${candidate.slice(0, 93).trimEnd()}…`;
}

/** IDs provide the only correlation signal accepted here; title similarity is deliberately ignored. */
export function presentExecutions(records: readonly ExecutionRecord[]): PresentedExecution[] {
  const groups: PresentedExecution[] = [];
  const indexed = new Map<string, PresentedExecution>();
  for (const record of records) {
    const identities = [record.key, record.id, record.childSessionId, record.subagentId, record.delegationId].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    const group = identities.map((id) => indexed.get(id)).find(Boolean);
    if (group) {
      group.members.push(record);
      if (record.state !== "unknown" && group.record.state === "unknown") group.record = record;
      for (const id of identities) indexed.set(id, group);
      continue;
    }
    const created = { key: record.key, record, members: [record] };
    groups.push(created);
    for (const id of identities) indexed.set(id, created);
  }
  return groups;
}
