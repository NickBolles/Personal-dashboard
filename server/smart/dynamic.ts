import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { getOwner, type CurrentUser } from "@/server/auth";
import { HttpError } from "@/server/http/errors";
import { getSetting, setSetting } from "@/server/settings";
import { adapterContext, cachedSource, scopeResult } from "@/server/sources";
import { resolveIntegration } from "@/integrations/store";
import { parseAllowlist } from "@/integrations/home-assistant/adapter";
import { addDays, localDate, localMinutes } from "@/lib/time";
import { CATALOG_ID, type UIElement, type JarvisSpec } from "@/lib/jarvis-ui/catalog";
import type { DynamicCard, DynamicResponse } from "@/lib/jarvis-ui/dynamic";
import { validateSpec } from "@/lib/jarvis-ui/validator";
import { can } from "@/server/access";
import { openItems, visibleEvents } from "./data";
import { getSmartSettings, itemExcluded, upsertSurface } from "./store";

export function isoWeekStart(today: string) {
  const day = new Date(`${today}T12:00:00Z`).getUTCDay();
  return addDays(today, -(day === 0 ? 6 : day - 1));
}
export function weeklyReviewWindow(today: string, minute: number) {
  const day = new Date(`${today}T12:00:00Z`).getUTCDay();
  return day === 6 || day === 0 || (day === 5 && minute >= 720);
}
const doneKey = (userId: string, week: string) => `smart:weekly-review:${userId}:${week}`;
export function markDynamicApplied(userId: string, sessionId: string, done: boolean) {
  const week = sessionId.match(/^dynamic:weekly-review:(\d{4}-\d{2}-\d{2})$/)?.[1];
  if (week) setSetting(doneKey(userId, week), done);
}
const plain = (s: string, max = 200) => s.replace(/https?:\/\/\S+|www\.\S+|<[^>]*>/gi, "").slice(0, max);
const element = (type: UIElement["type"], props: Record<string, unknown>): UIElement => ({ type, props });
function spec(elements: Record<string, UIElement>): JarvisSpec {
  const v = validateSpec({ v: 1, catalog: CATALOG_ID, root: "r", elements });
  if (!v.ok || v.dropped) throw new Error("Invalid dynamic template");
  return v.spec;
}
function single(type: UIElement["type"], props: Record<string, unknown>) {
  return spec({ r: element(type, props) });
}

/** Fixed templates, cached source reads only: no model, no provider writes, no Finance. */
export function dynamicCards(user: CurrentUser, now = new Date(), requestedId?: string): DynamicResponse {
  if (getOwner()?.id !== user.id) throw new HttpError(403, "owner_only", "Only the owner can open these cards.");
  const ctx = adapterContext(now);
  const today = localDate(now, ctx.timezone);
  if (!getSmartSettings(user.id).enabled) return { cards: [], today };
  const { items, byId } = openItems(user);
  const parents = [...byId.values()].filter((i) => !i.archived && !itemExcluded(i, byId) && (i.kind === "area" || i.kind === "project")).slice(0, 30);
  const cards: DynamicCard[] = [];
  const add = (card: Omit<DynamicCard, "sessionId" | "blockIndex">) => {
    const sessionId = `dynamic:${card.id}`;
    // Freeze the questionnaire for draft recovery. Live read cards get a new
    // immutable, hash-keyed surface when their snapshot changes.
    const existing = getDb()
      .select()
      .from(schema.uiSurfaces)
      .where(and(eq(schema.uiSurfaces.userId, user.id), eq(schema.uiSurfaces.sessionId, sessionId)))
      .get();
    const stored = existing ? validateSpec(JSON.parse(existing.specJson)) : null;
    const built = card.kind === "weekly-review" && stored?.ok ? stored.spec : card.spec;
    upsertSurface(user, { sessionId, blockIndex: 0, spec: built });
    cards.push({ ...card, spec: built, sessionId, blockIndex: 0 });
  };
  const ha = scopeResult(user, cachedSource("home_assistant", now));
  if (ha?.status.state === "ok")
    for (const garage of ha.data?.homeExceptions ?? []) {
      if (!/^cover\..*garage/i.test(garage.entityId) || garage.state !== "open") continue;
      const mins = garage.since ? Math.floor((now.getTime() - Date.parse(garage.since)) / 60_000) : 0;
      if (mins < 30 && localMinutes(now, ctx.timezone) < 1260) continue;
      const rules = parseAllowlist(resolveIntegration("home_assistant").config.controlAllowlist);
      const services = can(user, "home_assistant.control_doors") ? (rules.find((r) => r.entityId === garage.entityId)?.services ?? []) : [];
      add({
        id: `garage:${garage.entityId}:${today}`,
        kind: "garage",
        action: "Review",
        line: { tone: "bad", dot: "red", icon: "◇", label: "Garage", text: `Open${garage.since ? ` for ${Math.max(0, mins)} min` : ""}` },
        spec: single("Callout", {
          tone: "warn",
          title: "Garage door",
          text: `State: open · since ${garage.since ? new Date(garage.since).toLocaleTimeString("en-US", { timeZone: ctx.timezone, hour: "numeric", minute: "2-digit" }) : "unknown"} · ${garage.entityId}. ${services.includes("close_cover") ? "Closing requires confirmation." : "Close from Home Assistant."}`,
        }),
        garage: { entityId: garage.entityId, closeAllowed: services.includes("close_cover"), undoAllowed: services.includes("open_cover") },
        footer: { label: "Open Home Assistant controls", href: `/home-control?entity=${encodeURIComponent(garage.entityId)}` },
      });
      break;
    }
  const events = visibleEvents(user, now)
    .filter(
      (e) =>
        !e.allDay &&
        e.endsAt &&
        Date.parse(e.endsAt) > now.getTime() &&
        localDate(new Date(e.startsAt), ctx.timezone) >= today &&
        localDate(new Date(e.startsAt), ctx.timezone) <= addDays(today, 1),
    )
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const pair = events.flatMap((a, i) =>
    events
      .slice(i + 1)
      .filter((b) => a.id !== b.id && Date.parse(b.startsAt) < Date.parse(a.endsAt!) && Date.parse(b.endsAt!) > Date.parse(a.startsAt))
      .map((b) => [a, b] as const),
  )[0];
  if (pair && parents.length) {
    const [a, b] = pair;
    add({
      id: `calendar-conflict:${today}`,
      kind: "calendar-conflict",
      action: "Review",
      line: { tone: "warn", dot: "yellow", icon: "▦", label: "Calendar", text: `${a.title} overlaps ${b.title}` },
      spec: spec({
        r: { type: "Stack", props: {}, children: ["timeline", "choice"] },
        timeline: element("Table", {
          columns: [
            { key: "event", label: "Event" },
            { key: "start", label: "Start" },
            { key: "end", label: "End" },
          ],
          rows: pair.map((e) => ({
            cells: {
              event: e.title.slice(0, 200),
              start: new Date(e.startsAt).toLocaleString("en-US", { timeZone: ctx.timezone, weekday: "short", hour: "numeric", minute: "2-digit" }),
              end: new Date(e.endsAt!).toLocaleTimeString("en-US", { timeZone: ctx.timezone, hour: "numeric", minute: "2-digit" }),
            },
          })),
        }),
        choice: element("DecisionCard", {
          title: "Resolve the overlap",
          context: "Create a call task; this never changes calendar events.",
          options: pair.map((e, i) => ({
            id: `move${i}`,
            label: `Call to move ${e.title}`.slice(0, 200),
            intent: { kind: "item.create", parentRef: `item:${parents[0]!.id}`, title: `Call to move ${e.title}`.slice(0, 200), targetDate: addDays(today, 1) },
          })),
        }),
      }),
    });
  }
  const week = isoWeekStart(today);
  if (can(user, "work.use") && parents.length && weeklyReviewWindow(today, localMinutes(now, ctx.timezone)) && !getSetting<boolean>(doneKey(user.id, week))) {
    const done = [...byId.values()].filter(
      (i) =>
        i.completedAt &&
        localDate(new Date(i.completedAt), ctx.timezone) >= week &&
        localDate(new Date(i.completedAt), ctx.timezone) <= today &&
        !itemExcluded(i, byId),
    );
    const slipped = items.filter((i) => i.targetDate && i.targetDate < today).slice(0, 20);
    add({
      id: `weekly-review:${week}`,
      kind: "weekly-review",
      action: "Fill in",
      line: { tone: "warn", dot: "yellow", icon: "≡", label: "Weekly review", text: "4 questions · about 4 min" },
      spec: single("Form", {
        title: "Weekly review",
        fields: [
          { id: "rating", label: "How did the week go?", kind: "scale", required: true },
          {
            id: "wins",
            label: "Wins",
            kind: "textarea",
            ...(done.length
              ? {
                  proposed: done
                    .map((i) => plain(i.title, 100))
                    .join("\n")
                    .slice(0, 1800),
                }
              : {}),
          },
          {
            id: "slipped",
            label: "What slipped?",
            kind: "choice",
            options: [{ value: "none", label: "Nothing to carry over" }, ...slipped.map((i) => ({ value: i.id, label: plain(i.title) }))],
          },
          { id: "next", label: "Top 3 for next week", kind: "textarea", required: true },
          {
            id: "parent",
            label: "Create under",
            kind: "choice",
            required: true,
            options: parents.map((i) => ({ value: `item:${i.id}`, label: plain(i.title) })),
          },
        ],
        submit: {
          label: "Submit",
          creates: [{ parentField: "parent", parentRefs: parents.map((i) => `item:${i.id}`), titleField: "next", splitLines: true, maxItems: 3 }],
        },
      }),
    });
  }
  const sky = scopeResult(user, cachedSource("skylight", now));
  if (sky?.status.state === "ok" && sky.data) {
    const chores = sky.data.actions.filter((a) => {
      if (a.skylight?.kind === "chore")
        return (
          (a.status !== "completed" || !a.skylight.completedOn || a.skylight.completedOn === today) && (!a.skylight.startDate || a.skylight.startDate <= today)
        );
      // Hermes snapshots are already today-only; they deliberately carry no write ref or assignee.
      return a.sourceLabel === "Skylight · Chores";
    });
    if (chores.length) {
      const done = chores.filter((a) => a.status === "completed");
      const grabs = chores.filter((a) => a.status === "open" && a.assignee?.kind === "up_for_grabs");
      const unknown = chores.filter((a) => a.status === "open" && !a.assignee);
      add({
        id: `chores:${today}`,
        kind: "chores",
        action: "Open",
        line: {
          tone: "ok",
          dot: null,
          icon: "✓",
          label: "Chores",
          text: `${done.length} of ${chores.length} done · ${unknown.length ? "assignments unavailable" : `${grabs.length} up for grabs`}`,
        },
        spec: single("Table", {
          columns: [
            { key: "state", label: "State" },
            { key: "chore", label: "Chore" },
          ],
          rows: [...done, ...grabs, ...unknown].slice(0, 50).map((a) => ({
            cells: {
              state: a.status === "completed" ? "✓ Done" : a.assignee ? "Up for grabs" : "Open · assignment unavailable",
              chore: a.title.slice(0, 200),
            },
          })),
        }),
        footer: { label: "Open Skylight", href: "/skylight" },
      });
    }
  }
  // A queued draft stays reachable after its weekly prompt window closes.
  if (requestedId && /^weekly-review:\d{4}-\d{2}-\d{2}$/.test(requestedId) && !cards.some((c) => c.id === requestedId)) {
    const row = getDb()
      .select()
      .from(schema.uiSurfaces)
      .where(and(eq(schema.uiSurfaces.userId, user.id), eq(schema.uiSurfaces.sessionId, `dynamic:${requestedId}`)))
      .get();
    if (row && (JSON.parse(row.stateJson) as { pending?: number }).pending) {
      const v = validateSpec(JSON.parse(row.specJson));
      if (v.ok)
        cards.push({
          id: requestedId,
          kind: "weekly-review",
          action: "Fill in",
          line: { tone: "warn", dot: "yellow", icon: "≡", label: "Weekly review", text: "Draft · continue review" },
          sessionId: row.sessionId!,
          blockIndex: row.blockIndex,
          spec: v.spec,
        });
    }
  }
  return { cards, today };
}
