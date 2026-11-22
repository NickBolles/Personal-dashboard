import "server-only";
import { processSingleton } from "@/server/singleton";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { newId } from "@/server/crypto";
import { HttpError } from "@/server/http/errors";
import { getSetting, setSetting } from "@/server/settings";
import { addDays } from "@/lib/time";
import {
  BRIEF_EXPORT_KIND,
  BRIEF_LIMITS,
  BRIEF_NOTE_KINDS,
  DEFAULT_BRIEF_SETTINGS,
  normalizeNote,
  type BriefDoc,
  type BriefFeedbackInput,
  type BriefFeedbackView,
  type BriefNoteKind,
  type BriefNoteView,
  type BriefSettings,
  type BriefStepInput,
  type BriefVerdict,
} from "@/lib/brief";

/**
 * Daily brief storage (docs/brief.md): per-person settings, AI-built briefs,
 * feedback and the notes that make up "what Jarvis knows about you". Everything
 * here is private to the person and never edits source data.
 */

const B = schema.briefs;
const F = schema.briefFeedback;
const N = schema.briefNotes;

export type BriefRow = typeof B.$inferSelect;
type NoteRow = typeof N.$inferSelect;

// ---------------------------------------------------------------- settings

const settingsKey = (userId: string) => `brief:user:${userId}`;

export function getBriefSettings(userId: string): BriefSettings {
  const s = getSetting<Partial<BriefSettings>>(settingsKey(userId));
  const d = DEFAULT_BRIEF_SETTINGS;
  const share = { ...d.share, ...(s?.share ?? {}) };
  return {
    ai: s?.ai === true,
    auto: s?.auto ?? d.auto,
    buildAt: typeof s?.buildAt === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s.buildAt) ? s.buildAt : d.buildAt,
    cycle: s?.cycle === true,
    improveAreaId: typeof s?.improveAreaId === "string" && s.improveAreaId ? s.improveAreaId : null,
    share: {
      todos: share.todos !== false,
      work: share.work !== false,
      calendar: share.calendar !== false,
      household: share.household !== false,
      checkins: share.checkins !== false,
      workouts: share.workouts !== false,
      done: share.done !== false,
      memory: share.memory !== false,
    },
  };
}

export function saveBriefSettings(userId: string, patch: Partial<Omit<BriefSettings, "share">> & { share?: Partial<BriefSettings["share"]> }): BriefSettings {
  const cur = getBriefSettings(userId);
  const next: BriefSettings = { ...cur, ...patch, share: { ...cur.share, ...(patch.share ?? {}) } };
  setSetting(settingsKey(userId), next);
  return next;
}

/** People who asked for a scheduled build (the dispatcher task reads this). */
export function listAutoBriefUsers(): string[] {
  return getDb()
    .select({ key: schema.settings.key })
    .from(schema.settings)
    .all()
    .map((r) => r.key)
    .filter((k) => k.startsWith("brief:user:"))
    .map((k) => k.slice("brief:user:".length))
    .filter((id) => {
      const s = getBriefSettings(id);
      return s.ai && s.auto;
    });
}

// ---------------------------------------------------------------- briefs

export function latestBrief(userId: string, date: string): BriefRow | undefined {
  return getDb()
    .select()
    .from(B)
    .where(and(eq(B.userId, userId), eq(B.date, date)))
    .orderBy(desc(B.createdAt))
    .limit(1)
    .get();
}

export function ownedBrief(userId: string, id: string): BriefRow {
  const row = getDb()
    .select()
    .from(B)
    .where(and(eq(B.id, id), eq(B.userId, userId)))
    .get();
  if (!row) throw new HttpError(404, "not_found", "That brief isn't available");
  return row;
}

export function insertBrief(input: { userId: string; date: string; jobId: string | null; model: string | null; doc: BriefDoc; basedOn: string[] }): BriefRow {
  const id = newId("brf");
  getDb()
    .insert(B)
    .values({
      id,
      userId: input.userId,
      date: input.date,
      jobId: input.jobId,
      model: input.model,
      docJson: JSON.stringify(input.doc),
      basedOn: JSON.stringify(input.basedOn.slice(0, 12)),
      createdAt: new Date().toISOString(),
    })
    .run();
  pruneBriefs(input.userId, input.date);
  return getDb().select().from(B).where(eq(B.id, id)).get()!;
}

/** Keep 60 days of briefs: enough to look back, small enough to stay private by default. */
function pruneBriefs(userId: string, today: string) {
  const cutoff = addDays(today, -60);
  const old = getDb()
    .select({ id: B.id, date: B.date })
    .from(B)
    .where(eq(B.userId, userId))
    .all()
    .filter((r) => r.date < cutoff)
    .map((r) => r.id);
  if (!old.length) return;
  getDb().delete(F).where(inArray(F.briefId, old)).run();
  getDb().delete(B).where(inArray(B.id, old)).run();
}

export function parseDoc(row: BriefRow): BriefDoc {
  return JSON.parse(row.docJson) as BriefDoc;
}

export function parseOutcomes(row: BriefRow): Record<string, string> {
  try {
    return JSON.parse(row.outcomes) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Record picks seen completed (first sighting wins). Returns the day's outcomes so far. */
export function recordOutcomes(row: BriefRow, doneIds: string[], at = new Date()): Record<string, string> {
  const cur = parseOutcomes(row);
  let changed = false;
  for (const id of doneIds)
    if (!cur[id]) {
      cur[id] = at.toISOString();
      changed = true;
    }
  if (changed)
    getDb()
      .update(B)
      .set({ outcomes: JSON.stringify(cur) })
      .where(eq(B.id, row.id))
      .run();
  return cur;
}

export function parseTicks(row: BriefRow): Record<string, string> {
  try {
    return JSON.parse(row.ticks) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Indexes of a card's steps that are ticked. */
export function tickedSteps(ticks: Record<string, string>, blockId: string, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) if (ticks[`${blockId}:${i}`]) out.push(i);
  return out;
}

/** Tick or untick one small step on a card of the person's own brief. Unticking is the undo. */
export function setTick(userId: string, input: BriefStepInput, at = new Date()): { blockId: string; done: number[] } {
  const row = ownedBrief(userId, input.briefId);
  const block = parseDoc(row).blocks.find((b) => b.id === input.blockId);
  const count = block?.steps?.length ?? 0;
  if (input.index >= count) throw new HttpError(404, "not_found", "That step isn't on this brief");
  const cur = parseTicks(row);
  const key = `${input.blockId}:${input.index}`;
  if (input.done) cur[key] ??= at.toISOString();
  else delete cur[key];
  getDb()
    .update(B)
    .set({ ticks: JSON.stringify(cur) })
    .where(eq(B.id, row.id))
    .run();
  return { blockId: input.blockId, done: tickedSteps(cur, input.blockId, count) };
}

/** The last brief of each recent day before `today`, newest first (for "what happened to yesterday's picks"). */
export function recentBriefs(userId: string, today: string, days = 7): BriefRow[] {
  const rows = getDb()
    .select()
    .from(B)
    .where(and(eq(B.userId, userId), gte(B.date, addDays(today, -days))))
    .orderBy(desc(B.createdAt))
    .all();
  const seen = new Set<string>();
  return rows.filter((r) => r.date < today && !seen.has(r.date) && seen.add(r.date));
}

// ---------------------------------------------------------------- feedback

const feedbackView = (r: typeof F.$inferSelect): BriefFeedbackView => ({
  id: r.id,
  targetKey: r.targetKey,
  verdict: r.verdict as BriefVerdict,
  ...(r.note ? { note: r.note } : {}),
});

export function feedbackFor(userId: string, briefId: string): BriefFeedbackView[] {
  return getDb()
    .select()
    .from(F)
    .where(and(eq(F.userId, userId), eq(F.briefId, briefId)))
    .all()
    .map(feedbackView);
}

/** What a target said when the person reacted, so the next build can quote it back. */
function excerptFor(doc: BriefDoc, targetKey: string): { kind: string; excerpt: string } | null {
  if (targetKey === "brief") return { kind: "brief", excerpt: doc.headline };
  if (targetKey.startsWith("pick:")) {
    const id = targetKey.slice(5);
    if (doc.first?.actionId === id) return { kind: "first", excerpt: doc.first.title };
    const then = doc.then.find((p) => p.actionId === id);
    return then ? { kind: "then", excerpt: then.title } : null;
  }
  const block = doc.blocks.find((b) => `block:${b.id}` === targetKey);
  return block ? { kind: block.kind, excerpt: [block.title, block.text].filter(Boolean).join(": ") } : null;
}

/** One reaction per target: a new verdict replaces the old one, `null` removes it. */
export function setFeedback(userId: string, input: BriefFeedbackInput): { feedback: BriefFeedbackView[]; previous: BriefFeedbackView | null } {
  const row = ownedBrief(userId, input.briefId);
  const target = excerptFor(parseDoc(row), input.targetKey);
  if (!target) throw new HttpError(400, "bad_target", "That isn't part of this brief");
  const db = getDb();
  const where = and(eq(F.userId, userId), eq(F.briefId, row.id), eq(F.targetKey, input.targetKey));
  const prior = db.select().from(F).where(where).get();
  if (input.verdict === null) db.delete(F).where(where).run();
  else if (prior)
    db.update(F)
      .set({ verdict: input.verdict, note: input.note ?? "", createdAt: new Date().toISOString() })
      .where(where)
      .run();
  else
    db.insert(F)
      .values({
        id: newId("bfb"),
        userId,
        briefId: row.id,
        date: row.date,
        targetKey: input.targetKey,
        targetKind: target.kind,
        verdict: input.verdict,
        note: input.note ?? "",
        excerpt: target.excerpt.slice(0, 200),
        createdAt: new Date().toISOString(),
      })
      .run();
  return { feedback: feedbackFor(userId, row.id), previous: prior ? feedbackView(prior) : null };
}

export type RecentFeedback = {
  id: string;
  date: string;
  kind: string;
  verdict: BriefVerdict;
  note: string;
  excerpt: string;
  briefId: string;
  targetKey: string;
};

/** Feedback from the last `days` days, newest first (bounded: it goes into the next build's context). */
export function recentFeedback(userId: string, today: string, days = 14, limit = 20): RecentFeedback[] {
  return getDb()
    .select()
    .from(F)
    .where(and(eq(F.userId, userId), gte(F.date, addDays(today, -days))))
    .orderBy(desc(F.createdAt))
    .limit(limit)
    .all()
    .map((r) => ({
      id: r.id,
      date: r.date,
      kind: r.targetKind,
      verdict: r.verdict as BriefVerdict,
      note: r.note,
      excerpt: r.excerpt,
      briefId: r.briefId,
      targetKey: r.targetKey,
    }));
}

/** The stored documents of this person's briefs, by id (to look up what a piece of feedback was about). */
export function briefDocs(userId: string, ids: string[]): Map<string, BriefDoc> {
  if (!ids.length) return new Map();
  return new Map(
    getDb()
      .select()
      .from(B)
      .where(and(eq(B.userId, userId), inArray(B.id, ids)))
      .all()
      .map((r) => [r.id, parseDoc(r)]),
  );
}

// ---------------------------------------------------------------- notes ("what Jarvis knows about you")

const noteKind = (k: string | null | undefined): BriefNoteKind =>
  (BRIEF_NOTE_KINDS as readonly string[]).includes(k ?? "") ? (k as BriefNoteKind) : "pattern";

const noteView = (r: NoteRow): BriefNoteView => ({
  id: r.id,
  kind: noteKind(r.kind),
  text: r.text,
  origin: r.origin as BriefNoteView["origin"],
  state: r.state as BriefNoteView["state"],
  ...(r.evidence ? { evidence: r.evidence } : {}),
  createdAt: r.createdAt,
});

export function listNotes(userId: string, states: BriefNoteView["state"][] = ["active", "proposed"]): BriefNoteView[] {
  return getDb()
    .select()
    .from(N)
    .where(and(eq(N.userId, userId), inArray(N.state, states)))
    .orderBy(desc(N.createdAt))
    .all()
    .map(noteView);
}

function ownedNote(userId: string, id: string): NoteRow {
  const row = getDb()
    .select()
    .from(N)
    .where(and(eq(N.id, id), eq(N.userId, userId)))
    .get();
  if (!row) throw new HttpError(404, "not_found", "That note isn't available");
  return row;
}

function activeCount(userId: string) {
  return getDb()
    .select({ id: N.id })
    .from(N)
    .where(and(eq(N.userId, userId), eq(N.state, "active")))
    .all().length;
}

/** A note the person wrote: active at once. Writing a note that was dismissed or proposed brings it back as theirs. */
export function addNote(userId: string, text: string, origin: BriefNoteView["origin"] = "you", kind: BriefNoteKind = "pattern"): BriefNoteView {
  const norm = normalizeNote(text);
  if (norm.length < 3) throw new HttpError(400, "bad_note", "Write a few words");
  const db = getDb();
  const at = new Date().toISOString();
  const existing = db
    .select()
    .from(N)
    .where(and(eq(N.userId, userId), eq(N.norm, norm)))
    .get();
  if (existing?.state === "active") return noteView(existing);
  if (activeCount(userId) >= BRIEF_LIMITS.notes) throw new HttpError(409, "too_many", `Up to ${BRIEF_LIMITS.notes} notes. Remove one first.`);
  if (existing) {
    db.update(N).set({ text, kind, state: "active", origin, updatedAt: at }).where(eq(N.id, existing.id)).run();
    return noteView(ownedNote(userId, existing.id));
  }
  const id = newId("bnt");
  db.insert(N).values({ id, userId, kind, text, norm, origin, state: "active", createdAt: at, updatedAt: at }).run();
  return noteView(ownedNote(userId, id));
}

export function patchNote(userId: string, id: string, patch: { text?: string; state?: BriefNoteView["state"] }): BriefNoteView {
  const row = ownedNote(userId, id);
  const db = getDb();
  const set: Partial<NoteRow> = { updatedAt: new Date().toISOString() };
  if (patch.text !== undefined && patch.text !== row.text) {
    const norm = normalizeNote(patch.text);
    const clash = db
      .select({ id: N.id })
      .from(N)
      .where(and(eq(N.userId, userId), eq(N.norm, norm)))
      .get();
    if (clash && clash.id !== id) throw new HttpError(409, "duplicate", "You already have that note");
    set.text = patch.text;
    set.norm = norm;
  }
  if (patch.state && patch.state !== row.state) {
    if (patch.state === "active" && activeCount(userId) >= BRIEF_LIMITS.notes)
      throw new HttpError(409, "too_many", `Up to ${BRIEF_LIMITS.notes} notes. Remove one first.`);
    set.state = patch.state;
  }
  db.update(N).set(set).where(eq(N.id, id)).run();
  return noteView(ownedNote(userId, id));
}

/** Removing a note the model proposed keeps a dismissed marker (so it isn't proposed again); a person's own note is deleted. */
export function removeNote(userId: string, id: string): BriefNoteView {
  const row = ownedNote(userId, id);
  if (row.origin === "learned") return patchNote(userId, id, { state: "dismissed" });
  getDb().delete(N).where(eq(N.id, id)).run();
  return noteView(row);
}

/**
 * Notes the model proposed in a build. Stored as `proposed`: nothing uses them until the
 * person keeps them. Skips anything already known (active, proposed or dismissed).
 */
export function proposeNotes(userId: string, briefId: string, proposals: { text: string; evidence: string; kind?: BriefNoteKind }[]): number {
  const db = getDb();
  let pending = db
    .select({ id: N.id })
    .from(N)
    .where(and(eq(N.userId, userId), eq(N.state, "proposed")))
    .all().length;
  let added = 0;
  for (const p of proposals.slice(0, BRIEF_LIMITS.learned)) {
    if (pending >= BRIEF_LIMITS.pendingProposals) break;
    const norm = normalizeNote(p.text);
    if (norm.length < 8) continue;
    const known = db
      .select({ id: N.id })
      .from(N)
      .where(and(eq(N.userId, userId), eq(N.norm, norm)))
      .get();
    if (known) continue;
    const at = new Date().toISOString();
    db.insert(N)
      .values({
        id: newId("bnt"),
        userId,
        kind: noteKind(p.kind),
        text: p.text,
        norm,
        origin: "learned",
        state: "proposed",
        evidence: p.evidence,
        briefId,
        createdAt: at,
        updatedAt: at,
      })
      .run();
    pending++;
    added++;
  }
  return added;
}

export function exportProfile(userId: string) {
  return {
    kind: BRIEF_EXPORT_KIND,
    version: 1 as const,
    exportedAt: new Date().toISOString(),
    notes: listNotes(userId, ["active"]).map((n) => ({ text: n.text, origin: n.origin, kind: n.kind })),
  };
}

/**
 * Adds notes that aren't there yet; never removes one. A note that was dismissed or still only proposed comes back
 * as active (that changes what the next build uses), so the import remembers each note it wrote and how the ones it
 * revived were before: `undo` takes exactly this import back for the next minute.
 */
export function importProfile(
  userId: string,
  notes: { text: string; origin?: BriefNoteView["origin"]; kind?: BriefNoteKind }[],
  now = Date.now(),
): { added: number; skipped: number; undo?: string } {
  const db = getDb();
  let added = 0;
  let skipped = 0;
  const created: string[] = [];
  const prior: NoteRow[] = [];
  for (const n of notes) {
    const before = activeCount(userId);
    if (before >= BRIEF_LIMITS.notes) {
      skipped++;
      continue;
    }
    const was = db
      .select()
      .from(N)
      .where(and(eq(N.userId, userId), eq(N.norm, normalizeNote(n.text))))
      .get();
    const note = addNote(userId, n.text, n.origin ?? "you", n.kind ?? "pattern");
    if (activeCount(userId) > before) {
      added++;
      if (was) prior.push(was);
      else created.push(note.id);
    } else skipped++;
  }
  return { added, skipped, ...(added ? { undo: hold(userId, { kind: "import", created, prior }, now) } : {}) };
}

/** Everything the brief stored about a person (Settings → Brief → Reset). */
type Change = { kind: "reset"; notes: NoteRow[]; feedback: (typeof F.$inferSelect)[] } | { kind: "import"; created: string[]; prior: NoteRow[] };
type Held = Change & { token: string; until: number };
const RESET_UNDO_MS = 60_000;
/**
 * What the last "Forget everything" removed or the last import changed, per person, for Undo. In memory only:
 * never written anywhere, gone after a minute or a restart. One at a time: a newer one replaces it.
 */
const held = () => processSingleton("brief_reset_undo", () => new Map<string, Held>());
function hold(userId: string, change: Change, now: number): string {
  const map = held();
  for (const [id, h] of map) if (h.until <= now) map.delete(id);
  const token = newId("bru");
  map.set(userId, { ...change, token, until: now + RESET_UNDO_MS });
  return token;
}

/** Forget everything the brief learned about this person. Returns a token that puts it back for the next minute. */
export function resetProfile(userId: string, now = Date.now()): string {
  const db = getDb();
  const notes = db.select().from(N).where(eq(N.userId, userId)).all();
  const feedback = db.select().from(F).where(eq(F.userId, userId)).all();
  db.delete(N).where(eq(N.userId, userId)).run();
  db.delete(F).where(eq(F.userId, userId)).run();
  return hold(userId, { kind: "reset", notes, feedback }, now);
}

/**
 * Undo, once. After "Forget everything": puts back what that reset removed, except where something newer has taken
 * its place. After an import: removes the notes it wrote and sets the ones it revived back to how they were.
 */
export function restoreProfile(userId: string, token: string, now = Date.now()): { notes: number; feedback: number } {
  const map = held();
  const h = map.get(userId);
  if (h && h.until <= now) map.delete(userId);
  if (!h || h.token !== token || h.until <= now) throw new HttpError(410, "undo_expired", "That can't be undone any more");
  map.delete(userId);
  const db = getDb();
  if (h.kind === "import") {
    for (const id of h.created)
      db.delete(N)
        .where(and(eq(N.id, id), eq(N.userId, userId)))
        .run();
    for (const { id, ...was } of h.prior)
      db.update(N)
        .set(was)
        .where(and(eq(N.id, id), eq(N.userId, userId)))
        .run();
    return { notes: h.created.length + h.prior.length, feedback: 0 };
  }
  let notes = 0;
  let feedback = 0;
  for (const n of h.notes) {
    const clash = db
      .select({ id: N.id })
      .from(N)
      .where(and(eq(N.userId, userId), eq(N.norm, n.norm)))
      .get();
    if (clash) continue;
    db.insert(N).values(n).run();
    notes++;
  }
  const briefs = new Set(
    db
      .select({ id: B.id })
      .from(B)
      .where(eq(B.userId, userId))
      .all()
      .map((r) => r.id),
  );
  for (const f of h.feedback) {
    if (!briefs.has(f.briefId)) continue;
    const clash = db
      .select({ id: F.id })
      .from(F)
      .where(and(eq(F.userId, userId), eq(F.briefId, f.briefId), eq(F.targetKey, f.targetKey)))
      .get();
    if (clash) continue;
    db.insert(F).values(f).run();
    feedback++;
  }
  return { notes, feedback };
}
