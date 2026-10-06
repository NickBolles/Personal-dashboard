import { api } from "@/server/http/api";
import { getHome } from "@/server/sources";
import { unreadActionableCount } from "@/server/notifications";
import type { WidgetSummary } from "@/lib/contracts";

export const dynamic = "force-dynamic";

/** Small payload for phone home-screen widgets. Reads cached snapshots only: widgets never wait on upstreams. */
export const GET = api(async ({ user }): Promise<WidgetSummary> => {
  const home = await getHome({ live: false });
  const top = [...home.now, ...home.later.laterToday].slice(0, 5);
  const ex = home.glance.homeExceptions;
  return {
    generatedAt: home.generatedAt,
    unread: unreadActionableCount(user.id),
    next: top.map(({ id, source, title, detail, priorityReason, dueAt, dueIsDate, primaryAction, secondaryActions, href }) => ({
      id,
      source,
      title,
      detail,
      priorityReason,
      dueAt,
      dueIsDate,
      primaryAction,
      secondaryActions,
      href,
    })),
    nextEvent: home.glance.nextEvent
      ? (({ title, startsAt, endsAt, allDay, location, source }) => ({ title, startsAt, endsAt, allDay, location, source }))(home.glance.nextEvent)
      : undefined,
    compass: home.glance.compass,
    home: {
      exceptions: ex.slice(0, 6).map(({ name, reason, severity, state }) => ({ name, reason, severity, state })),
      critical: ex.filter((e) => e.severity === "critical" || e.severity === "high").length,
    },
    degradedSources: home.sources.filter((s) => ["error", "unauthorized", "stale"].includes(s.state)).map((s) => s.label),
  };
});
