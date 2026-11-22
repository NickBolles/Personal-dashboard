import type { NextAction } from "@/lib/contracts";
import {
  BRIEF_BASIS,
  BRIEF_LIMITS,
  BRIEF_REF,
  BRIEF_VERSION,
  briefBlockOut,
  briefLearnedOut,
  briefPickOut,
  isWidgetKind,
  shortHash,
  type BriefBasis,
  type BriefBlockDoc,
  type BriefBlockKind,
  type BriefNoteKind,
  type BriefDoc,
  type BriefOutput,
  type BriefPickDoc,
} from "@/lib/brief";

/**
 * Pure brief composition (no I/O, unit-tested in test/brief-compose.test.ts):
 *
 * - `rulesBrief`: the brief Jarvis builds without a model, straight from the
 *   Home ranking. Always available, so the page never waits on AI.
 * - `resolveOutput`: turns a model answer into a stored document. Refs the
 *   model didn't get are dropped, titles always come from Jarvis' own data,
 *   and a malformed card is dropped on its own instead of failing the brief.
 */

export type ComposeInput = {
  today: string;
  now: NextAction[];
  later: NextAction[];
  totals: { now: number; today: number; overdue: number; open: number };
  focus: string[];
  hasEvents: boolean;
  hasCompass: boolean;
  hasDates: boolean;
  hasTrend: boolean;
  hasExceptions: boolean;
  hasTraining?: boolean;
};

const pick = (a: NextAction): BriefPickDoc => ({ actionId: a.id, title: a.title, why: (a.why ?? []).slice(0, 2).join(". ") });

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function rulesBrief(i: ComposeInput): BriefDoc {
  const ordered = [...i.now, ...i.later];
  const [first, ...rest] = ordered;
  const headline = !first
    ? "Nothing needs you right now"
    : i.focus.length
      ? `Today's focus: ${i.focus[0]}`.slice(0, BRIEF_LIMITS.headline)
      : i.totals.now > 1
        ? `${plural(i.totals.now, "thing")} need you first`
        : "One thing needs you first";
  const lead = !first
    ? "Nothing is due or waiting on you. A good day to pull something forward from the backlog."
    : [
        i.totals.overdue ? `${plural(i.totals.overdue, "item")} overdue.` : "",
        i.totals.today ? `${plural(i.totals.today, "more thing")} later today.` : "",
        "Ordered by due time and what you pinned.",
      ]
        .filter(Boolean)
        .join(" ");
  const blocks: BriefBlockDoc[] = [];
  const widget = (kind: BriefBlockKind) => blocks.push({ id: `w-${kind}`, kind });
  if (i.hasEvents) widget("schedule");
  if (i.hasCompass) widget("compass");
  if (i.hasExceptions) widget("household");
  if (i.hasDates) widget("dates");
  if (i.hasTraining) widget("training");
  if (i.hasTrend) widget("momentum");
  return {
    v: BRIEF_VERSION,
    headline,
    lead,
    first: first ? pick(first) : null,
    then: rest.slice(0, 3).map(pick),
    blocks,
  };
}

export type ResolveMaps = {
  /** ref → action, exactly the candidates the model was given */
  byRef: Map<string, NextAction>;
  /** basis id (`n:…`, `c:…`, `f:…`, `src:…`) → what to show for it; only what the model was actually given */
  basis: Map<string, BriefBasis>;
  /** widgets that have data to show; others are dropped */
  widgets: Set<string>;
};

export type Resolved = { doc: BriefDoc; learned: { kind: BriefNoteKind; text: string; evidence: string }[]; dropped: number };

/** Cards about the person must say what they rest on: with no basis Jarvis can check, an observation is a guess and is dropped. */
const NEEDS_BASIS: ReadonlySet<string> = new Set(["insight", "callout"]);
/** Cards that may list small things to do, and cards that may put a question to the person. */
const MAY_STEP: ReadonlySet<string> = new Set(["idea", "callout", "nudge"]);
const MAY_ASK: ReadonlySet<string> = new Set(["insight", "callout", "reflect"]);

/**
 * Plain text only: the model's narrative is rendered as text, but strip markup and links so nothing
 * looks clickable. Text that runs long is clipped at a word with an ellipsis rather than dropped.
 */
function plain(text: string | undefined, max: number) {
  const clean = (text ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/\bhttps?:\/\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

export function resolveOutput(out: BriefOutput, maps: ResolveMaps): Resolved {
  let dropped = 0;
  const used = new Set<string>();
  const toPick = (raw: unknown): BriefPickDoc | null => {
    const p = briefPickOut.safeParse(raw);
    const action = p.success ? maps.byRef.get(p.data.ref) : undefined;
    if (!p.success || !action || used.has(action.id)) {
      if (raw != null) dropped++;
      return null;
    }
    used.add(action.id);
    const step = plain(p.data.step, BRIEF_LIMITS.step);
    return { actionId: action.id, title: action.title, why: plain(p.data.why, BRIEF_LIMITS.why), ...(step ? { step } : {}) };
  };

  const picks = [toPick(out.first), ...out.then.map(toPick)].filter((p): p is BriefPickDoc => p !== null);
  const first = picks[0] ?? null;
  const then = picks.slice(1, 1 + BRIEF_LIMITS.then);

  const blocks: BriefBlockDoc[] = [];
  const seenWidgets = new Set<string>();
  for (const raw of out.blocks) {
    if (blocks.length >= BRIEF_LIMITS.blocks) break;
    const b = briefBlockOut.safeParse(raw);
    if (!b.success) {
      dropped++;
      continue;
    }
    const { kind } = b.data;
    const text = plain(b.data.text, BRIEF_LIMITS.blockText);
    const title = plain(b.data.title, BRIEF_LIMITS.blockTitle);
    if (isWidgetKind(kind)) {
      if (!maps.widgets.has(kind) || seenWidgets.has(kind)) {
        dropped++;
        continue;
      }
      seenWidgets.add(kind);
      blocks.push({ id: `w-${kind}`, kind, ...(text ? { text } : {}) });
      continue;
    }
    if (!text) {
      dropped++;
      continue;
    }
    const actions = [...new Set(b.data.refs ?? [])]
      .filter((r) => BRIEF_REF.test(r))
      .map((r) => maps.byRef.get(r))
      .filter((a): a is NextAction => Boolean(a))
      .slice(0, BRIEF_LIMITS.blockRefs)
      .map((a) => ({ actionId: a.id, title: a.title }));
    const basis = [...new Set(b.data.basis ?? [])]
      .filter((id) => BRIEF_BASIS.test(id))
      .map((id) => maps.basis.get(id))
      .filter((x): x is BriefBasis => Boolean(x))
      .slice(0, BRIEF_LIMITS.basis);
    if (NEEDS_BASIS.has(kind) && !basis.length) {
      dropped++;
      continue;
    }
    const steps = MAY_STEP.has(kind)
      ? (b.data.steps ?? [])
          .map((x) => plain(x, BRIEF_LIMITS.blockStep))
          .filter(Boolean)
          .slice(0, BRIEF_LIMITS.blockSteps)
      : [];
    const ask = MAY_ASK.has(kind) ? plain(b.data.ask, BRIEF_LIMITS.blockAsk) : "";
    blocks.push({
      id: `c-${shortHash(`${kind}|${title}|${text}`)}-${blocks.length}`,
      kind,
      ...(title ? { title } : {}),
      text,
      ...(actions.length ? { actions } : {}),
      ...(basis.length ? { basis } : {}),
      ...(steps.length ? { steps } : {}),
      ...(ask ? { ask } : {}),
    });
  }

  const learned = out.learned
    .map((raw) => briefLearnedOut.safeParse(raw))
    .filter((p) => p.success)
    .map((p) => ({ kind: p.data!.kind, text: plain(p.data!.text, BRIEF_LIMITS.note), evidence: plain(p.data!.evidence, BRIEF_LIMITS.evidence) }))
    .filter((p) => p.text.length >= 8)
    .slice(0, BRIEF_LIMITS.learned);

  return {
    doc: {
      v: BRIEF_VERSION,
      headline: plain(out.headline, BRIEF_LIMITS.headline) || "Today",
      lead: plain(out.lead, BRIEF_LIMITS.lead),
      first,
      then,
      blocks,
    },
    learned,
    dropped,
  };
}
