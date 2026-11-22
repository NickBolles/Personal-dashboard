/**
 * Daily brief (docs/brief.md): shared zod schemas and view types. Client-safe,
 * no server imports. The brief is one page that says what matters most today
 * and what to start with. It is written by the AI layer from a bounded,
 * allowlisted context (server/brief/context.ts) or, when AI is off or
 * unavailable, built by rules from the Home ranking (server/brief/rules.ts).
 *
 * The model never supplies facts: it copies opaque refs, and Jarvis hydrates
 * titles, times and numbers from its own data. The model writes only the
 * narrative (headline, why, card text).
 */
import { z } from "zod";
import type { NextAction } from "@/lib/contracts";

export const BRIEF_VERSION = 1;

/**
 * Cards the model writes. The first six are about the day; `insight` (something it noticed about the
 * person), `idea` (one to three small things worth doing) and `callout` (where what they do and what
 * they say they value have drifted apart) are about the person.
 */
export const BRIEF_CARD_KINDS = ["focus", "watch", "nudge", "defer", "win", "reflect", "insight", "idea", "callout"] as const;
/** Widgets Jarvis fills with its own data; the model only chooses to show them and may add one line. */
export const BRIEF_WIDGET_KINDS = ["schedule", "momentum", "household", "dates", "compass", "training"] as const;
export const BRIEF_BLOCK_KINDS = [...BRIEF_CARD_KINDS, ...BRIEF_WIDGET_KINDS] as const;
export type BriefCardKind = (typeof BRIEF_CARD_KINDS)[number];
export type BriefWidgetKind = (typeof BRIEF_WIDGET_KINDS)[number];
export type BriefBlockKind = (typeof BRIEF_BLOCK_KINDS)[number];
export const isWidgetKind = (k: string): k is BriefWidgetKind => (BRIEF_WIDGET_KINDS as readonly string[]).includes(k);

export const BRIEF_KIND_LABEL: Record<BriefBlockKind, string> = {
  focus: "Focus",
  watch: "Watch",
  nudge: "Nudge",
  defer: "Not today",
  win: "Momentum",
  reflect: "Tonight",
  insight: "Noticed",
  idea: "Idea",
  callout: "Honest take",
  schedule: "Your day",
  momentum: "Trend",
  household: "Household",
  dates: "Coming up",
  compass: "Daily Compass",
  training: "Training",
};

export const BRIEF_LIMITS = {
  headline: 90,
  lead: 320,
  why: 220,
  step: 140,
  then: 4,
  blocks: 10,
  blockTitle: 70,
  blockText: 320,
  blockRefs: 4,
  /** small things to do on an idea/callout/nudge card */
  blockSteps: 3,
  blockStep: 100,
  /** the one question a card may put to the person */
  blockAsk: 140,
  deckRows: 3,
  /** the Urgent card holds the big rocks and the rest of today, so it shows a few more */
  urgentRows: 5,
  /** an "Improve" request, and how many open requests (of both kinds) the brief lists */
  improve: 2000,
  improveOpen: 4,
  /** next steps an agent left on a row it looked into, and how long that row keeps saying so */
  assistSteps: 5,
  assistStep: 140,
  assistDays: 3,
  basis: 4,
  learned: 3,
  note: 200,
  evidence: 300,
  notes: 40,
  pendingProposals: 6,
  feedbackNote: 300,
  /** AI builds a person may start per local day (the scheduled build counts) */
  buildsPerDay: 4,
} as const;

// --- Model output (lenient at the top, strict per part: a bad card is dropped, not the whole brief) ---

const s = (max: number) => z.string().trim().max(max);
/** Opaque ref the model copies from the context table (`a` + 6 hex). */
export const BRIEF_REF = /^a[0-9a-f]{6}$/;
const ref = z.string().regex(BRIEF_REF);
/** Whole inputs a card may rest on (besides single notes, check-ins and feedback rows). */
export const BRIEF_BASIS_SOURCES = ["workouts", "done", "calendar", "memory"] as const;
export type BriefBasisSource = (typeof BRIEF_BASIS_SOURCES)[number];
export const BRIEF_BASIS_SOURCE_LABEL: Record<BriefBasisSource, string> = {
  workouts: "your workouts",
  done: "what you finished lately",
  calendar: "your calendar",
  memory: "what Hermes remembers of you",
};
/**
 * What a card says it is based on: a profile note (`n:` + 6 hex), a check-in day (`c:YYYY-MM-DD`),
 * a feedback row (`f:` + 6 hex) or a whole input (`src:workouts`, `src:done`, `src:calendar`, `src:memory`).
 */
export const BRIEF_BASIS = /^(n:[0-9a-f]{6}|c:\d{4}-\d{2}-\d{2}|f:[0-9a-f]{6}|src:(workouts|done|calendar|memory))$/;

/** Text limits here are generous: a model that runs a little long is clipped to BRIEF_LIMITS when resolved, not thrown away. */
const LOOSE = 2000;
export const briefPickOut = z.object({ ref, why: s(LOOSE).default(""), step: s(LOOSE).optional() });
export const briefBlockOut = z.object({
  kind: z.enum(BRIEF_BLOCK_KINDS),
  title: s(LOOSE).optional(),
  text: s(LOOSE).optional(),
  refs: z.array(z.string().max(20)).max(12).optional(),
  basis: z.array(z.string().max(60)).max(12).optional(),
  steps: z.array(z.string().max(LOOSE)).max(10).optional(),
  ask: s(LOOSE).optional(),
});
/** What a lasting note is about. A proposal with no (or an unknown) kind is a pattern. */
export const BRIEF_NOTE_KINDS = ["value", "principle", "driver", "pattern"] as const;
export type BriefNoteKind = (typeof BRIEF_NOTE_KINDS)[number];
export const BRIEF_NOTE_KIND_LABEL: Record<BriefNoteKind, string> = { value: "Value", principle: "Principle", driver: "Driver", pattern: "Pattern" };
export const briefLearnedOut = z.object({
  kind: z.enum(BRIEF_NOTE_KINDS).catch("pattern").default("pattern"),
  text: s(LOOSE).min(8),
  evidence: s(LOOSE).default(""),
});

export const briefOutput = z
  .object({
    headline: s(LOOSE).min(1),
    lead: s(LOOSE).default(""),
    first: z.unknown().optional(),
    then: z.array(z.unknown()).max(20).default([]),
    blocks: z.array(z.unknown()).max(30).default([]),
    learned: z.array(z.unknown()).max(10).default([]),
  })
  .passthrough();
export type BriefOutput = z.infer<typeof briefOutput>;

// --- Stored document (resolved refs; what a brief row holds) ---

export type BriefBasis = { kind: "note" | "checkin" | "feedback" | "source"; id: string; label: string };
/** Where a stored reference came from, so a later build can recheck it against the sharing rules of that day. */
export type BriefOrigin = { source?: NextAction["source"]; sourceId?: string };
export type BriefPickDoc = { actionId: string; title: string; why: string; step?: string } & BriefOrigin;
export type BriefBlockDoc = {
  id: string;
  kind: BriefBlockKind;
  title?: string;
  text?: string;
  actions?: ({ actionId: string; title: string } & BriefOrigin)[];
  basis?: BriefBasis[];
  /** one to three small things to do (plain text; nothing is created from them) */
  steps?: string[];
  /** a question for the person; the page offers to answer it in a chat */
  ask?: string;
};
export type BriefDoc = {
  v: typeof BRIEF_VERSION;
  headline: string;
  lead: string;
  first: BriefPickDoc | null;
  then: BriefPickDoc[];
  blocks: BriefBlockDoc[];
};

// --- View (GET /api/brief) ---

export type BriefSource = "ai" | "rules";
export type PickState = "open" | "done" | "gone";
export type BriefPickView = BriefPickDoc & { state: PickState; action?: NextAction };
export type BriefScheduleEvent = { id: string; title: string; startsAt: string; endsAt?: string; allDay?: boolean; calendar?: string; past?: boolean };
export type BriefWidgetData =
  | { kind: "schedule"; events: BriefScheduleEvent[]; known: boolean }
  | { kind: "momentum"; days: string[]; added: number[]; completed: number[] }
  | { kind: "household"; exceptions: { name: string; reason: string; severity: string; href: string }[]; known: boolean }
  | { kind: "dates"; dates: { id: string; title: string; date: string; inDays: number }[] }
  | { kind: "compass"; completed: boolean; inWindow: boolean; windowLabel: string; focus: string[]; yesterday?: { summary?: string; tomorrow?: string } }
  /** completed workouts per week, oldest first (the last entry is the current week) */
  | { kind: "training"; weeks: { start: string; sessions: number }[]; last?: { date: string; title: string } };
export type BriefBlockView = Omit<BriefBlockDoc, "actions"> & {
  actions?: { actionId: string; title: string; state: PickState; href?: string }[];
  widget?: BriefWidgetData;
  /** indexes of `steps` the person ticked off */
  done?: number[];
};

/**
 * The rows under the picks: everything that is not one of the top few things, as cards built by Jarvis
 * on read. Three rows of two cards: Next up (Urgent, Decisions), Initiatives (Habits, In progress) and
 * Coming up (On the calendar, Low priority).
 */
export const BRIEF_DECK_KINDS = ["urgent", "decisions", "habits", "initiatives", "ahead", "low"] as const;
export type BriefDeckKind = (typeof BRIEF_DECK_KINDS)[number];
export const BRIEF_DECK_LABEL: Record<BriefDeckKind, string> = {
  urgent: "Urgent",
  decisions: "Decisions",
  habits: "Habits",
  initiatives: "In progress",
  ahead: "On the calendar",
  low: "Low priority",
};
export const BRIEF_DECK_GROUPS = ["next", "initiatives", "coming"] as const;
export type BriefDeckGroup = (typeof BRIEF_DECK_GROUPS)[number];
export const BRIEF_DECK_GROUP_LABEL: Record<BriefDeckGroup, string> = { next: "Next up", initiatives: "Initiatives", coming: "Coming up" };
export const BRIEF_DECK_GROUP_OF: Record<BriefDeckKind, BriefDeckGroup> = {
  urgent: "next",
  decisions: "next",
  habits: "initiatives",
  initiatives: "initiatives",
  ahead: "coming",
  low: "coming",
};

/**
 * "Look into it" on a row (the sparkle): what an agent is asked to find out. Which rows get one is a
 * rule on the title (`assistIntent`), never a model's choice.
 */
export const BRIEF_ASSIST_INTENTS = ["book", "fix", "call", "buy", "admin", "plan", "research", "steps"] as const;
export type BriefAssistIntent = (typeof BRIEF_ASSIST_INTENTS)[number];
/** The button, and the same thing while it is under way. */
export const BRIEF_ASSIST_LABEL: Record<BriefAssistIntent, string> = {
  book: "Find how to book",
  fix: "Find who can help",
  call: "Find who to call",
  buy: "Compare options",
  admin: "Find the steps",
  plan: "Draft a plan",
  research: "Look into it",
  steps: "Work out next steps",
};
export const BRIEF_ASSIST_DOING: Record<BriefAssistIntent, string> = {
  book: "Finding how to book",
  fix: "Finding who can help",
  call: "Finding who to call",
  buy: "Comparing options",
  admin: "Finding the steps",
  plan: "Drafting a plan",
  research: "Looking into it",
  steps: "Working out next steps",
};
/** First match wins: an appointment to book beats the "call" inside it. */
const ASSIST_RULES: [BriefAssistIntent, RegExp][] = [
  ["book", /\b(schedule|reschedule|book|reserve|reservation|appointment|appt|check-?up)\b/i],
  ["fix", /\b(fix|repair|replace|install|service|inspect|mount|unclog|tune-?up)\b/i],
  ["call", /\b(call|phone|ring|contact|email|e-mail|message|follow up with)\b/i],
  ["buy", /\b(buy|order|purchase|shop for|pick out|get a quote|quote|estimate|compare|choose)\b/i],
  ["admin", /\b(renew|cancel|return|refund|register|sign up|apply|file|submit|claim|transfer|update my)\b/i],
  ["plan", /\b(plan|organi[sz]e|arrange|prepare for|set up)\b/i],
  ["research", /\b(research|look into|look up|find out|figure out|find|decide on)\b/i],
];
export function assistIntent(title: string): BriefAssistIntent | null {
  for (const [intent, re] of ASSIST_RULES) if (re.test(title)) return intent;
  return null;
}

/** How the agent stands on a request, from Jarvis' own run records (lib/agent-runs.ts RunLive). */
export type BriefImprovementLive = "running" | "waiting" | "failed" | "finished" | "idle";
export type BriefAssistTarget = { kind: "action" | "item"; id: string };
export type BriefAssistView = {
  intent: BriefAssistIntent;
  /** what the row is, for the server to look up again: a Home action or an item in Areas */
  target: BriefAssistTarget;
  /** set once the person started it */
  request?: {
    id: string;
    live: BriefImprovementLive;
    /** paused on an approval only the person can give */
    approval?: boolean;
    sessionId: string;
    /** the next step the agent left on the item it was filed as */
    next?: string;
    /** the rest, from the "Next steps" note the agent left there */
    steps?: string[];
  };
};

export type BriefDeckRow = {
  id: string;
  title: string;
  meta?: string;
  /** a time the page formats locally (a due time, an event start) */
  at?: string;
  allDay?: boolean;
  href?: string;
  external?: boolean;
  done?: boolean;
  /** an agent can look into this one (and how that stands, once asked) */
  assist?: BriefAssistView;
};
export type BriefDeckCard = {
  kind: BriefDeckKind;
  /** how many there are in all (the card shows the first few) */
  total: number;
  rows: BriefDeckRow[];
  /** where the rest live */
  more?: string;
};

export const BRIEF_VERDICTS = ["up", "down"] as const;
export type BriefVerdict = (typeof BRIEF_VERDICTS)[number];
export type BriefFeedbackView = { id: string; targetKey: string; verdict: BriefVerdict; note?: string };

export const BRIEF_NOTE_ORIGINS = ["you", "learned"] as const;
export const BRIEF_NOTE_STATES = ["active", "proposed", "dismissed"] as const;
export type BriefNoteView = {
  id: string;
  kind: BriefNoteKind;
  text: string;
  origin: (typeof BRIEF_NOTE_ORIGINS)[number];
  state: (typeof BRIEF_NOTE_STATES)[number];
  evidence?: string;
  createdAt: string;
};

/** Something the person handed to an agent from the brief: a change to the app ("improve") or one row to look into ("assist"). */
export type BriefImprovementView = {
  id: string;
  kind: "improve" | "assist";
  title: string;
  live: BriefImprovementLive;
  /** paused on an approval only the person can give */
  approval?: boolean;
  itemId: string;
  sessionId: string;
  createdAt: string;
};
export type BriefImproveView = {
  /** false: no button (no chat or work access, or Hermes is not connected) */
  available: boolean;
  /** where a request goes unless the person picks another area (null: Miscellaneous) */
  areaId: string | null;
  /** areas that may take AI work, for the picker */
  areas: { id: string; title: string; agent: string | null }[];
  /** requests still open, newest first */
  open: BriefImprovementView[];
};
export const BRIEF_IMPROVE_LABEL: Record<BriefImprovementLive, string> = {
  running: "Working",
  waiting: "Needs you",
  failed: "Stopped",
  finished: "Replied",
  idle: "Starting",
};

export type BriefBuildState = "idle" | "queued" | "building" | "blocked" | "failed";
export type BriefSettings = {
  /** let the AI layer write the brief (off: rules only) */
  ai: boolean;
  /** build today's brief in the background at `buildAt`, and on the first open of the day */
  auto: boolean;
  /** local HH:MM for the scheduled build */
  buildAt: string;
  /** the Insights carousel moves to the next card by itself until it is touched */
  cycle: boolean;
  /** the area whose agent takes "Improve" requests (null: Jarvis picks, see server/brief/improve.ts) */
  improveAreaId: string | null;
  /** what the model may see (Finance and AI-excluded areas are never sent) */
  share: {
    todos: boolean;
    work: boolean;
    calendar: boolean;
    household: boolean;
    checkins: boolean;
    /** completed workout sessions (dates and titles) */
    workouts: boolean;
    /** titles of what was finished in the last week */
    done: boolean;
    /** let Hermes draw on what it already remembers of the person (nothing extra is sent) */
    memory: boolean;
  };
};
export const DEFAULT_BRIEF_SETTINGS: BriefSettings = {
  ai: false,
  auto: true,
  buildAt: "06:00",
  cycle: false,
  improveAreaId: null,
  share: { todos: true, work: true, calendar: true, household: true, checkins: true, workouts: true, done: true, memory: true },
};
export const briefSettingsPatch = z
  .object({
    ai: z.boolean().optional(),
    auto: z.boolean().optional(),
    buildAt: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
    cycle: z.boolean().optional(),
    improveAreaId: z.string().min(1).max(80).nullable().optional(),
    share: z
      .object({
        todos: z.boolean().optional(),
        work: z.boolean().optional(),
        calendar: z.boolean().optional(),
        household: z.boolean().optional(),
        checkins: z.boolean().optional(),
        workouts: z.boolean().optional(),
        done: z.boolean().optional(),
        memory: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type BriefView = {
  date: string;
  timezone: string;
  brief: {
    /** null for the rules brief (computed on read, never stored) */
    id: string | null;
    source: BriefSource;
    builtAt: string;
    model: string | null;
    headline: string;
    lead: string;
    first: BriefPickView | null;
    then: BriefPickView[];
    /** open safety alerts the picks left out: always shown, whatever the model chose */
    alerts: BriefPickView[];
    blocks: BriefBlockView[];
    /** what the model was given, by label ("Todos", "Calendar", "3 things you taught Jarvis") */
    basedOn: string[];
  };
  /** today's calendar, for the day arc and the "right now" line (Jarvis' own data, whatever the model placed) */
  day?: { events: BriefScheduleEvent[]; known: boolean };
  /** the cards under the picks, in order; the page groups them into rows (BRIEF_DECK_GROUP_OF). May be empty. */
  deck: BriefDeckCard[];
  /** "Improve": whether this person can hand a change to an agent from here, where it goes, and what is under way */
  improve: BriefImproveView;
  build: { state: BriefBuildState; message?: string; jobId?: string; buildsToday: number; buildsLeft: number };
  ai: { on: boolean; available: boolean; reason?: string };
  settings: BriefSettings;
  feedback: BriefFeedbackView[];
  proposals: BriefNoteView[];
  notes: { active: number };
};

// --- Request bodies ---

const key = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

export const briefBuildSchema = z.object({ clientKey: key, budgetOverride: z.boolean().optional() }).strict();

export const briefFeedbackSchema = z
  .object({
    briefId: z.string().min(1).max(80),
    /** `brief` (the whole page), `pick:<actionId>` or `block:<blockId>` */
    targetKey: z
      .string()
      .min(3)
      .max(340)
      .regex(/^(brief|pick:.{1,300}|block:[a-z0-9_-]{1,40})$/),
    /** null clears the person's feedback on that target */
    verdict: z.enum(BRIEF_VERDICTS).nullable(),
    note: z.string().trim().max(BRIEF_LIMITS.feedbackNote).optional(),
  })
  .strict();
export type BriefFeedbackInput = z.infer<typeof briefFeedbackSchema>;

/** Tick or untick one small step on a card. */
export const briefStepSchema = z
  .object({
    briefId: z.string().min(1).max(80),
    blockId: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[a-z0-9_-]+$/),
    index: z
      .number()
      .int()
      .min(0)
      .max(BRIEF_LIMITS.blockSteps - 1),
    done: z.boolean(),
  })
  .strict();
export type BriefStepInput = z.infer<typeof briefStepSchema>;

/** "Improve": what should change, in the person's words, and optionally which area's agent takes it. */
export const briefImproveSchema = z
  .object({
    text: z.string().trim().min(3).max(BRIEF_LIMITS.improve),
    /** omit to let Jarvis pick; null files it under Miscellaneous */
    areaId: z.string().min(1).max(80).nullable().optional(),
    clientKey: key,
  })
  .strict();
export type BriefImproveInput = z.infer<typeof briefImproveSchema>;

/** The sparkle on a row: which row. Its title and everything else are read again on the server. */
export const briefAssistSchema = z
  .object({
    target: z.object({ kind: z.enum(["action", "item"]), id: z.string().min(1).max(300) }).strict(),
    clientKey: key,
  })
  .strict();
export type BriefAssistInput = z.infer<typeof briefAssistSchema>;

/** `kind` is for putting a forgotten note back as it was (Undo); a note the model proposed is restored by its state instead. */
export const briefNoteCreateSchema = z
  .object({
    text: z.string().trim().min(3).max(BRIEF_LIMITS.note),
    kind: z.enum(BRIEF_NOTE_KINDS).optional(),
  })
  .strict();
/** Undo of "Forget everything" or of an import: the token that change returned. */
export const briefRestoreSchema = z.object({ token: z.string().min(4).max(64) }).strict();
export const briefNotePatchSchema = z
  .object({
    text: z.string().trim().min(3).max(BRIEF_LIMITS.note).optional(),
    state: z.enum(BRIEF_NOTE_STATES).optional(),
  })
  .strict()
  .refine((p) => p.text !== undefined || p.state !== undefined, "Nothing to change");

/** Export/import of what a person taught the brief (Settings → Brief). */
export const BRIEF_EXPORT_KIND = "jarvis-brief-profile";
export const briefImportSchema = z
  .object({
    kind: z.literal(BRIEF_EXPORT_KIND),
    version: z.literal(1),
    notes: z
      .array(
        z
          .object({
            text: z.string().trim().min(3).max(BRIEF_LIMITS.note),
            origin: z.enum(BRIEF_NOTE_ORIGINS).optional(),
            kind: z.enum(BRIEF_NOTE_KINDS).optional(),
          })
          .strict(),
      )
      .max(BRIEF_LIMITS.notes),
  })
  .strict();

/**
 * Stable short ref for an action id (`a` + 6 hex, FNV-1a): the model copies it and the
 * server maps it back from the person's current actions, so no ref table is stored and a
 * build that is adopted after a restart still resolves.
 */
export function shortHash(id: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) & 0xffffff).toString(16).padStart(6, "0");
}
export const briefRef = (actionId: string) => `a${shortHash(actionId)}`;

/** Notes are compared without case or punctuation, so a dismissed proposal is never proposed again. */
export function normalizeNote(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
