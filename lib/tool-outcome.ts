import { redactToolText } from "./tool-presentation";
const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const short = (v: unknown) => (typeof v === "string" ? redactToolText(v).replace(/\s+/g, " ").slice(0, 120) : undefined);
function parse(v?: string): unknown {
  if (!v || v.length > 65536) return undefined;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
}
export type ToolOutcome = { label: string; href?: string; status?: string };
/** Decode only complete returned objects, including MCP text envelopes. No input-only success. */
export function toolOutcome(name: string, output?: string, depth = 0): ToolOutcome | undefined {
  if (depth > 4) return undefined;
  const body = record(parse(output));
  if (!body || body.error || body.isError || body.ok === false || body.success === false) return undefined;
  if (Array.isArray(body.content)) {
    for (const part of body.content) {
      const p = record(part);
      if (p?.type === "text" && typeof p.text === "string") {
        const out = toolOutcome(name, p.text, depth + 1);
        if (out) return out;
      }
    }
  }
  if (body.result && typeof body.result === "object") return toolOutcome(name, JSON.stringify(body.result), depth + 1);
  if (!/jarvis/.test(name)) return undefined;
  if (body.proposed === true) return { label: "Proposed · awaiting owner" };
  const item = record(body.item);
  if (item && typeof item.id === "string" && /^wk_[\w-]+$/.test(item.id)) {
    const verb = /update_item/.test(name) ? "Updated item" : /create_item|add_note/.test(name) ? "Created item" : "Item";
    return {
      label: `${verb}${short(item.title) ? ` · ${short(item.title)}` : ""}`,
      href: `/areas?item=${encodeURIComponent(item.id)}`,
      status: short(item.status),
    };
  }
  if (/run_start/.test(name) && typeof body.runId === "string" && /^arun_[\w-]+$/.test(body.runId))
    return { label: body.existing === true ? "Existing run" : "Run registered", status: body.runId };
  return undefined;
}
