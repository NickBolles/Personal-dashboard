import { formFields, type WorkflowDefinition } from "./definition";
import { parseScriptureRef, type ScriptureRef } from "./scripture";
import { parseDateWord } from "./smart-dates";

/** "/teaching Jake Fry John 15" → { slug: "teaching", rest: "Jake Fry John 15" } */
export function parseSlashCommand(input: string): { slug: string; rest: string } | null {
  const m = /^\/([a-z][a-z0-9-]{1,39})(?:\s+(.*))?$/i.exec(input.trim());
  return m ? { slug: m[1].toLowerCase(), rest: (m[2] ?? "").trim() } : null;
}

export type ArgValue = string | ScriptureRef | { label: string; kind: "saved" | "typed" } | { name: string };
export type PrefillResult = { values: Record<string, ArgValue>; unmatched: string };

/**
 * Map palette args to form fields (spec §12.8): typed matching first —
 * a Scripture reference → the scripture field, a date word → the date field,
 * a saved-place label → the place field — then the rest to the first
 * text/person field in `start.args` order.
 */
export function mapPaletteArgs(def: WorkflowDefinition, rest: string, opts: { now: Date; timezone: string; savedPlaces?: string[] }): PrefillResult {
  const fields = formFields(def, "start");
  const byId = new Map(fields.map((f) => [f.id, f]));
  const order = (def.start?.args?.length ? def.start.args : fields.map((f) => f.id)).map((id) => byId.get(id)).filter((f) => !!f);
  const values: Record<string, ArgValue> = {};
  let text = rest.replace(/\s+/g, " ").trim().slice(0, 300);
  if (!text) return { values, unmatched: "" };

  const scripture = fields.find((f) => f.type === "scripture");
  if (scripture) {
    // longest trailing/inner span that parses as a reference; single tokens too ("jn15:5", #122)
    const words = text.split(" ");
    outer: for (let len = Math.min(5, words.length); len >= 1; len--) {
      for (let i = 0; i + len <= words.length; i++) {
        const span = words.slice(i, i + len).join(" ");
        if (!/\d/.test(span)) continue;
        const r = parseScriptureRef(span);
        if (r.ok) {
          values[scripture.id] = r.ref;
          words.splice(i, len);
          text = words.join(" ");
          break outer;
        }
      }
    }
  }

  const dateField = fields.find((f) => f.type === "date" || f.type === "datetime");
  if (dateField) {
    const m = /(?:^|\s)(next sunday|today|tomorrow|sunday|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2})(?=\s|$)/i.exec(text);
    if (m) {
      const d = parseDateWord(m[1], opts);
      if (d) {
        values[dateField.id] = d;
        text = (text.slice(0, m.index) + " " + text.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim();
      }
    }
  }

  const placeField = fields.find((f) => f.type === "place");
  if (placeField) {
    const labels = [...(opts.savedPlaces ?? []), ...(def.defaultPlace ? [def.defaultPlace] : [])].sort((a, b) => b.length - a.length);
    const lower = text.toLowerCase();
    for (const label of labels) {
      const at = lower.indexOf(label.toLowerCase());
      if (at >= 0 && label) {
        values[placeField.id] = { label, kind: "saved" };
        text = (text.slice(0, at) + " " + text.slice(at + label.length))
          .replace(/\s+/g, " ")
          .replace(/^[-–,\s]+|[-–,\s]+$/g, "")
          .trim();
        break;
      }
    }
  }

  text = text.replace(/^[-–,\s]+|[-–,\s]+$/g, "");
  if (text) {
    const target = order.find((f) => (f.type === "text" || f.type === "person") && !(f.id in values));
    if (target) {
      values[target.id] = target.type === "person" ? { name: text.slice(0, 200) } : text.slice(0, 200);
      text = "";
    }
  }
  return { values, unmatched: text };
}

/** Human summary for the first chat message: "Speaker: Jake Fry · Main passage: John 15". */
export function describePrefill(def: WorkflowDefinition, values: Record<string, ArgValue>): string {
  const fields = formFields(def, "start");
  return fields
    .filter((f) => f.id in values)
    .map((f) => {
      const v = values[f.id];
      const s = typeof v === "string" ? v : "display" in v ? v.display : "label" in v ? v.label : v.name;
      return `${f.label}: ${s}`;
    })
    .join(" · ");
}
