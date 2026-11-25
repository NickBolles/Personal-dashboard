import { redactToolText } from "./tool-presentation";
import { parseToolResult } from "./chat/actions";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);
/** Accept nested JSON strings from persisted tool envelopes, without evaluating content. */
function decode(v: unknown): unknown {
  for (let n = 0; n < 3 && typeof v === "string" && v.length <= 262144; n++) {
    try {
      v = JSON.parse(v);
    } catch {
      break;
    }
  }
  return v;
}
const text = (v: unknown) => (typeof v === "string" && v.trim() ? redactToolText(v) : undefined);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const isDelegateTool = (name: string) => /(?:^|[.:_])delegate_task$/.test(name);
export type DelegateRow = { title?: string; input?: string; id?: string; status?: string; result?: string; duration?: string; href?: string };
const duration = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? `${v}s` : undefined);
function row(v: unknown): DelegateRow {
  const r = obj(decode(v)) ?? {};
  const href = text(r.url);
  return {
    title: text(r.title) ?? text(r.goal) ?? text(r.agent),
    input: text(r.instructions) ?? text(r.message) ?? text(r.prompt),
    id: text(r.subagent_id) ?? text(r.child_session_id) ?? text(r.id),
    status: text(r.status),
    result: text(r.error) ?? text(r.summary) ?? text(r.result) ?? text(r.reason) ?? text(r.note),
    duration: duration(r.duration_seconds ?? r.running_seconds),
    href: href && /^https:\/\//i.test(href) ? href : undefined,
  };
}
export function presentDelegate(input?: string, output?: string) {
  const a = obj(decode(input)) ?? {};
  const parsed = parseToolResult(output) ?? decode(output);
  const r = obj(parsed) ?? {};
  const action = text(a.action) ?? text(r.action) ?? (a.tasks || a.goal ? "spawn" : "details");
  const labels: Record<string, string> = {
    spawn: "Delegate tasks",
    list: "List agents",
    steer: "Guide agent",
    stop: "Request agent stop",
    results: "Delegation results",
  };
  const requested = list(a.tasks).map(row);
  if (!requested.length && (a.goal || a.message || a.instructions || a.subagent_id)) requested.push(row(a));
  let returned = list(r.results ?? r.subagents).map(row);
  if (!returned.length && Array.isArray(r.subagent_ids))
    returned = r.subagent_ids.map((id, i) => row({ subagent_id: id, goal: list(r.goals)[i], status: r.status }));
  const top = row(r);
  const error = text(r.error);
  return {
    action,
    label: labels[action] ?? "Delegated work",
    requested,
    returned,
    status: text(r.status),
    id: text(r.delegation_id) ?? top.id,
    count: typeof r.count === "number" && Number.isSafeInteger(r.count) && r.count >= 0 ? r.count : undefined,
    result:
      error && /No live subagent\b/i.test(error)
        ? "Agent is no longer running; it may have finished."
        : (top.result ?? (typeof parsed === "string" ? text(parsed) : undefined)),
    error: !!error || r.success === false || r.ok === false || returned.some((x) => x.status === "failed"),
  };
}
