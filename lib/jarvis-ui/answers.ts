import type { JarvisSpec, PropsOf } from "./catalog";
import { decisionRefOf, isQuestionnaire } from "./live";

export type AnswerQuestion = {
  id: string;
  title: string;
  context?: string;
  ref?: string;
  required: boolean;
  kind: "choice" | "text";
  options: { id: string; label: string; consequence?: string; recommended?: boolean }[];
  allowOther?: boolean;
};
export type AnswerValue = { choice: string; other?: string };
export type AnswerValues = Record<string, AnswerValue>;

/** Only conversational controls. Mixed intent/non-intent cards are unsupported, never half-functional. */
export function answerQuestions(spec: JarvisSpec, block: number): AnswerQuestion[] {
  const result: AnswerQuestion[] = [];
  for (const [key, el] of Object.entries(spec.elements)) {
    if (el.type === "DecisionCard") {
      const p = el.props as PropsOf<"DecisionCard">;
      if (p.options.some((o) => o.intent)) continue;
      result.push({
        id: `${block}:${p.id ?? key}`,
        title: p.title,
        context: p.context,
        ref: p.decisionRef ?? decisionRefOf(p.title) ?? undefined,
        required: p.required !== false,
        kind: "choice",
        options: p.options,
        allowOther: p.allowOther,
      });
    }
    if (el.type === "Form") {
      const p = el.props as PropsOf<"Form">;
      if (!isQuestionnaire(p)) continue;
      for (const f of p.fields)
        result.push({
          id: `${block}:${key}:${f.id}`,
          title: `${p.title} · ${f.label}`,
          required: !!f.required,
          kind: ["choice", "scale", "toggle"].includes(f.kind) ? "choice" : "text",
          options:
            f.kind === "scale"
              ? [1, 2, 3, 4, 5].map((n) => ({ id: String(n), label: String(n) }))
              : f.kind === "toggle"
                ? [
                    { id: "true", label: "Yes" },
                    { id: "false", label: "No" },
                  ]
                : (f.options ?? []).map((o) => ({ id: o.value, label: o.label })),
        });
    }
  }
  return result;
}
export function answerComplete(q: AnswerQuestion, v?: AnswerValue): boolean {
  if (!v) return !q.required;
  if (v.choice === "$skip") return !q.required;
  if (q.kind === "text") return !!v.other?.trim();
  if (v.choice === "$other") return !!q.allowOther && !!v.other?.trim();
  return q.options.some((o) => o.id === v.choice);
}
export function answerPayload(questions: AnswerQuestion[], values: AnswerValues): string {
  return [
    "My reviewed selections (conversation reply only; not authorization for money, devices, credentials, settlement or other actions):",
    ...questions.map((q) => {
      const v = values[q.id];
      const option = q.options.find((o) => o.id === v?.choice);
      return [
        `\n${q.ref ? `[${q.ref}] ` : ""}${q.title} [question:${q.id}]`,
        q.context ? `Context: ${q.context}` : "",
        !v || v.choice === "$skip"
          ? "Answer: skipped (optional)"
          : option
            ? `Answer: ${option.label} [choice:${option.id}]`
            : `Answer: ${q.kind === "text" ? "Written response" : "Other"} [choice:${v.choice}] — ${v.other?.trim()}`,
        option?.consequence ? `Discussed consequence (not executed): ${option.consequence}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }),
  ].join("\n");
}
/** Stable tab-local identity, with source text verified in the stored record against collisions. */
export function answerDraftKey(session: string, source: string): string {
  let h = 2166136261;
  for (let i = 0; i < source.length; i++) h = Math.imul(h ^ source.charCodeAt(i), 16777619);
  return `jarvis-answers:${session}:${(h >>> 0).toString(36)}`;
}
