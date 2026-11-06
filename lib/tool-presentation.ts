/** Bounded, client-safe presentation only. Never executes tools or infers mutation success. */
export type ToolKind = "file" | "terminal" | "agent" | "search" | "web" | "jarvis" | "tool";
export type ToolPresentation = { name: string; kind: ToolKind; label: string; target?: string; children: ToolPresentation[] };
const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
function parse(v: unknown): unknown {
  if (typeof v !== "string") return v;
  if (v.length > 65536) return undefined;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
}
export function redactToolText(text: string): string {
  return text
    .replace(/(api[_-]?key|token|secret|password|authorization)(["'\s:=]+)(?:(bearer|basic)\s+)?([^\s"',]{6,})/gi, "$1$2[redacted]")
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]");
}
const short = (v: unknown) => (typeof v === "string" ? redactToolText(v).replace(/\s+/g, " ").slice(0, 120) : undefined);
export function presentTool(name: string, input?: unknown, depth = 0): ToolPresentation {
  const args = record(parse(input)) ?? record(input);
  const lower = name.toLowerCase();
  let kind: ToolKind = "tool",
    label = "Used a tool";
  if (/jarvis/.test(lower)) {
    kind = "jarvis";
    label = "Jarvis request";
  } else if (/delegate|subagent/.test(lower)) {
    kind = "agent";
    label = "Delegated work";
  } else if (/terminal|execute_code|browser_exec|shell|process_manage/.test(lower)) {
    kind = "terminal";
    label = "Ran a command";
  } else if (/search|grep|find/.test(lower)) {
    kind = "search";
    label = "Searched";
  } else if (/read_file|skill_view/.test(lower)) {
    kind = "file";
    label = "Read a file";
  } else if (/write_file|patch/.test(lower)) {
    kind = "file";
    label = "Changed a file";
  } else if (/web_|browser/.test(lower)) {
    kind = "web";
    label = "Browsed";
  }
  if (kind === "jarvis")
    label = lower.includes("request_change")
      ? "Proposed a change"
      : lower.includes("run_start")
        ? "Requested agent run"
        : lower.includes("update_item")
          ? "Requested item update"
          : lower.includes("get_item")
            ? "Read item"
            : "Jarvis request";
  const children: ToolPresentation[] = [];
  if (depth < 3 && /tool_call|parallel/.test(lower)) {
    const calls = args?.calls ?? args?.tool_uses;
    if (Array.isArray(calls))
      for (const raw of calls.slice(0, 50)) {
        const call = record(raw);
        const childName = call?.name ?? call?.recipient_name;
        if (typeof childName === "string") children.push(presentTool(childName, call?.arguments ?? call?.parameters, depth + 1));
      }
  }
  if (children.length === 1) return { ...children[0], children, name };
  if (children.length > 1) {
    label = `${children.length} tool requests`;
    kind = "tool";
  }
  return {
    name,
    kind,
    label,
    target: short(
      args?.path ?? args?.file_path ?? args?.command ?? args?.query ?? args?.url ?? args?.title ?? args?.itemId ?? args?.id ?? args?.goal ?? args?.action,
    ),
    children,
  };
}
function hasFailure(raw: unknown, depth = 0): boolean {
  if (depth > 5) return false;
  const value = parse(raw);
  if (Array.isArray(value)) return value.slice(0, 50).some((v) => hasFailure(v, depth + 1));
  const v = record(value);
  if (!v) return false;
  if (v.error || v.isError === true || v.success === false || v.ok === false || v.status === "failed" || (typeof v.exit_code === "number" && v.exit_code !== 0))
    return true;
  if (v.result && hasFailure(v.result, depth + 1)) return true;
  if (v.results && hasFailure(v.results, depth + 1)) return true;
  if (Array.isArray(v.content))
    return v.content.slice(0, 50).some((p) => {
      const part = record(p);
      return part?.type === "text" && hasFailure(part.text, depth + 1);
    });
  return false;
}
export function toolResultState(output?: string, failed?: boolean, done = true): string {
  if (!done) return "running";
  if (failed || hasFailure(output) || /^(error|BLOCKED:)/i.test(output?.trim() ?? "")) return "failed";
  // A returned tool call is not evidence its proposed action took effect.
  return "returned";
}
