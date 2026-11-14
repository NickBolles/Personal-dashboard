import { splitBlocks } from "./parser";
import type { PropsOf } from "./catalog";

/**
 * Smart blocks that act through the conversation rather than the change tray (PR A, owner feedback 2026-11-13/14):
 *
 * - A `DecisionCard` titled with a decision reference ("D-33 · …") is the agent drawing one of the owner's D-n
 *   decisions. Its options carry no intents (an answer is recorded on the decision, not by Apply), so the card was
 *   drawn with every option disabled: "I can't click on the UI decision". Where the live decision can be drawn
 *   (coordinator rail/tray), it replaces the card.
 * - A `Form` with nothing to create or update is a questionnaire (e.g. the Daily Compass check-in). Submit used to
 *   stage nothing and say "Add an item for next week…": "The submit button isn't working". Its answers are now sent
 *   back into the conversation as the owner's reply.
 */

const DECISION_REF = /\bD-(\d{1,9})\b/;

/** The D-n a decision card's title names, or null. */
export function decisionRefOf(title: string | null | undefined): string | null {
  const m = DECISION_REF.exec(title ?? "");
  return m ? `D-${m[1]}` : null;
}

type Elements = Record<string, { type?: unknown; props?: unknown } | undefined>;

/** D-n refs of every DecisionCard in the message's (closed, parseable) smart blocks, in order, once each. */
export function smartDecisionRefs(text: string): string[] {
  if (!text.includes("jarvis-ui")) return [];
  const out: string[] = [];
  for (const seg of splitBlocks(text)) {
    if (seg.kind !== "block" || !seg.closed || seg.tooLarge) continue;
    let spec: { elements?: Elements } | null = null;
    try {
      spec = JSON.parse(seg.raw) as { elements?: Elements };
    } catch {
      continue;
    }
    for (const el of Object.values(spec?.elements ?? {})) {
      if (el?.type !== "DecisionCard") continue;
      const ref = decisionRefOf((el.props as { title?: string } | undefined)?.title);
      if (ref && !out.includes(ref)) out.push(ref);
    }
  }
  return out;
}

type FormProps = PropsOf<"Form">;

/** A form that writes nothing (no creates, no updates): its answers go back to the conversation. */
export function isQuestionnaire(p: Pick<FormProps, "submit">): boolean {
  return !p.submit.creates?.length && !p.submit.updates?.length;
}

/** The owner's answers as one readable reply: the form's title, then each answered question and its answer. */
export function questionnaireReply(p: Pick<FormProps, "title" | "fields">, values: Record<string, string | boolean | number | undefined>): string {
  const lines = [`**${p.title}**`];
  for (const f of p.fields) {
    const v = values[f.id];
    if (v === undefined || v === "") continue;
    const shown =
      f.kind === "toggle"
        ? v === true
          ? "Yes"
          : "No"
        : f.kind === "choice"
          ? (f.options?.find((o: { value: string; label: string }) => o.value === v)?.label ?? String(v))
          : String(v).trim();
    if (!shown) continue;
    lines.push("", `**${f.label}**`, shown);
  }
  return lines.join("\n").slice(0, 8000);
}
