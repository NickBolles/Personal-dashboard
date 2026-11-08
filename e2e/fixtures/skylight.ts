import type { NextAction } from "../../lib/contracts";
import { addDays, localDate, localTimeToInstant } from "../../lib/time";

/**
 * The one instant every Skylight visual pins the browser clock to (12:00 CDT on a Wednesday, far from DST
 * changes and day boundaries). Fixtures built from it have fixed due texts at any wall-clock time.
 */
export const SKYLIGHT_VISUAL_NOW = "2026-10-14T17:00:00.000Z";

/**
 * /api/sources/skylight for visual tests: two open chores and one done today (fixture text only).
 * Built at test time so freshness (fetchedAt/staleAfter) is real: a fixed past time would show
 * "Last updated N hours ago" on every card.
 */
export function skylightVisual(now = new Date()) {
  const at = now.toISOString();
  const staleAfter = new Date(now.getTime() + 60 * 60_000).toISOString();
  const base = { source: "skylight" as const, fetchedAt: at, staleAfter, href: "https://app.ourskylight.com/", external: true, updatedAt: at };
  const actions: NextAction[] = [
    {
      ...base,
      id: "skylight:vis-1",
      sourceId: "vis-1",
      title: "🪴 Visualsky water the ferns",
      detail: "Skylight chore · Nick",
      sourceLabel: "Skylight · Chores",
      assignee: { kind: "mine", name: "Nick" },
      status: "open",
      priorityReason: "today",
      primaryAction: { kind: "open", label: "Open Skylight" },
    },
    {
      ...base,
      id: "skylight:vis-2",
      sourceId: "vis-2",
      title: "🧺 Visualsky fold the towels",
      detail: "Skylight chore · up for grabs",
      sourceLabel: "Skylight · Up for grabs",
      assignee: { kind: "up_for_grabs" },
      status: "open",
      priorityReason: "today",
      primaryAction: { kind: "open", label: "Open Skylight" },
    },
    {
      ...base,
      id: "skylight:vis-3",
      sourceId: "vis-3",
      title: "🧽 Visualsky wipe the stovetop",
      detail: "Skylight chore · Nick",
      sourceLabel: "Skylight · Chores",
      assignee: { kind: "mine", name: "Nick" },
      status: "completed",
      priorityReason: "today",
    },
  ];
  return {
    status: { source: "skylight", label: "Skylight", state: "ok", fetchedAt: at, staleAfter },
    data: { actions, events: [], extra: { via: "direct", counts: { mine: 1, upForGrabs: 1, others: 0, hidden: 0, completedToday: 1 }, needsMember: false } },
  };
}

/** Writable source, entirely fixture-owned: no live lists/events leak into screenshots. */
export function skylightWriteVisual(now = new Date()) {
  const fixture = skylightVisual(now);
  const today = localDate(now, "America/Chicago");
  const tomorrow = addDays(today, 1);
  const actions: NextAction[] = fixture.data.actions.map((action, index) => ({
    ...action,
    dueAt: today,
    dueIsDate: true,
    skylight: { kind: "chore", choreId: `vis-${index + 1}`, categoryId: index === 1 ? null : "13600771", recurring: false },
  }));
  const lists = [
    { id: "7001", label: "Visualsky Groceries", kind: "grocery" },
    { id: "7002", label: "Visualsky House projects", kind: "task" },
  ];
  const listItems: NextAction[] = [
    { list: lists[0], itemId: "vis-oat", title: "Visualsky oat milk", status: "open" as const },
    { list: lists[0], itemId: "vis-coffee", title: "Visualsky coffee beans", status: "open" as const },
    { list: lists[0], itemId: "vis-paper", title: "Visualsky paper towels", status: "completed" as const },
    { list: lists[1], itemId: "vis-filter", title: "Visualsky replace furnace filter", status: "open" as const },
  ].map(({ list, itemId, title, status }) => ({
    ...actions[0],
    id: `skylight:list:${itemId}`,
    sourceId: itemId,
    title,
    status,
    sourceLabel: `Skylight · ${list.label}`,
    detail: list.label,
    assignee: undefined,
    primaryAction: undefined,
    skylight: { kind: "list_item", listId: list.id, itemId, listLabel: list.label },
  }));
  return {
    ...fixture,
    data: {
      actions,
      events: [
        {
          id: "skylight:vis-event",
          title: "Visualsky family walk",
          source: "skylight",
          allDay: false,
          startsAt: localTimeToInstant(tomorrow, "16:00", "America/Chicago").toISOString(),
          endsAt: localTimeToInstant(tomorrow, "17:00", "America/Chicago").toISOString(),
          location: "Visualsky park",
          skylight: { eventId: "vis-event", description: "Visualsky afternoon outside", editable: true },
        },
      ],
      extra: {
        ...fixture.data.extra,
        writable: true,
        window: { from: addDays(today, -7), to: addDays(today, 7) },
        lists,
        listItems,
        members: [{ id: "13600771", name: "Nick" }],
        health: { ok: true, failed: [] },
      },
    },
  };
}

/**
 * Skylight-style grouping (writable): Morning (00:30, already past at the frozen clock → amber), Afternoon, Evening,
 * Anytime up-for-grabs (Claim), a later-this-week chore, an overdue recurring occurrence (yesterday) and an overdue
 * one-off (3 days ago, red + Move to today), plus one done today.
 */
export function skylightGroupingVisual(now = new Date()) {
  const fixture = skylightWriteVisual(now);
  const tz = "America/Chicago";
  const today = localDate(now, tz);
  const [mine, grabs, done] = fixture.data.actions;
  const chore = (
    base: NextAction,
    id: string,
    title: string,
    day: string,
    time?: string,
    opts: { recurring?: boolean; priority?: NextAction["priorityReason"] } = {},
  ): NextAction => ({
    ...base,
    id: `skylight:${id}`,
    sourceId: id,
    title,
    priorityReason: opts.priority ?? (day < today ? "overdue" : day > today ? "upcoming" : "today"),
    ...(time
      ? { dueAt: localTimeToInstant(day, time, tz).toISOString(), dueIsDate: false }
      : day === today
        ? { dueAt: undefined, dueIsDate: undefined }
        : { dueAt: localTimeToInstant(day, "23:59", tz).toISOString(), dueIsDate: true, dueTimezone: tz }),
    skylight: {
      kind: "chore",
      choreId: opts.recurring ? `${id}-${day}${time ? `-${time.replace(":", "")}` : ""}` : id,
      categoryId: base.assignee?.kind === "up_for_grabs" ? null : "13600771",
      recurring: Boolean(opts.recurring),
      startDate: day,
      ...(time ? { startTime: time } : {}),
      ...(opts.recurring ? { instanceDate: day, ...(time ? { instanceTime: time } : {}) } : {}),
    },
  });
  const actions: NextAction[] = [
    chore(mine, "vis-g1", "🛏️ Visualsky make the beds", today, "00:30", { recurring: true, priority: "overdue" }),
    chore(mine, "vis-g2", "🐕 Visualsky walk the dog", today, "14:00", { recurring: true }),
    chore(mine, "vis-g3", "🍽️ Visualsky load the dishwasher", today, "20:00", { recurring: true }),
    chore(grabs, "vis-g4", "🧺 Visualsky fold the towels", today),
    chore(mine, "vis-g5", "🌿 Visualsky trim the hedge", addDays(today, 2)),
    chore(mine, "vis-g6", "🐟 Visualsky feed the fish", addDays(today, -1), "06:00", { recurring: true }),
    chore(mine, "vis-g7", "🫖 Visualsky descale the kettle", addDays(today, -3)),
    { ...done, skylight: { kind: "chore", choreId: "vis-3", categoryId: "13600771", recurring: false, completedOn: today } },
  ];
  return { ...fixture, data: { ...fixture.data, actions } };
}
