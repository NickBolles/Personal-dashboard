"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import type { NextAction } from "@/lib/contracts";
import { api } from "@/lib/client/api";
import { localDate } from "@/lib/time";
import { useAccess } from "@/components/access";
import { useSource } from "@/components/useSource";
import { SectionLabel, useNow } from "@/components/ui";
import { SkylightChoreGroups } from "./SkylightChoreGroups";
import { useSkylightWrite } from "./useSkylightWrite";
import type { SkylightExtra } from "./model";

/** Today's chores only: scheduled today (or undated), overdue ones, and those done today. */
export function todaysChores(actions: NextAction[], today: string) {
  return actions.filter((a) => {
    if (a.source !== "skylight" || (a.skylight && a.skylight.kind !== "chore")) return false;
    const ref = a.skylight;
    if (a.status === "completed") return !ref?.completedOn || ref.completedOn === today;
    if (a.status !== "open") return false;
    const day = ref?.instanceDate ?? ref?.startDate;
    return !day || day <= today;
  });
}

/**
 * Today's Skylight chores, grouped and completable in place (Today page and the Chief of staff tray card).
 * Mine (mine + up for grabs) by default; Everyone is one tap. Hermes-mode chores (no Skylight ref) stay read-only.
 */
export function TodayChores({
  id = "today-chores",
  variant = "section",
  fallback = null,
}: {
  id?: string;
  variant?: "section" | "card";
  /** Rendered instead when there is nothing to show (e.g. the tray card's server-built table). */
  fallback?: ReactNode;
}) {
  const { can } = useAccess();
  const sky = useSource("skylight");
  const write = useSkylightWrite();
  const now = useNow();
  const prefs = useQuery({ queryKey: ["preferences"], queryFn: () => api.get<{ timezone: string }>("/api/settings") });
  const timezone = prefs.data?.timezone || "America/Chicago";
  const extra = (sky.data?.data?.extra ?? {}) as SkylightExtra;
  const writable = extra.writable === true && can("skylight.write");
  const [everyone, setEveryone] = useState(false);
  const today = localDate(now, timezone);
  const raw = sky.data?.data?.actions;
  const chores = useMemo(
    () => todaysChores(raw ?? [], today).filter((a) => everyone || extra.needsMember || a.assignee?.kind !== "other"),
    [raw, today, everyone, extra.needsMember],
  );
  if (!can("skylight.view") || !sky.data?.data || !todaysChores(raw ?? [], today).length) return <>{fallback}</>;
  const open = chores.filter((a) => a.status === "open").length;
  // A quiet text toggle (one primary per row stays the rows'): Mine = yours + up for grabs.
  const toggle = (
    <button
      type="button"
      aria-pressed={everyone}
      onClick={() => setEveryone(!everyone)}
      title={everyone ? "Showing everyone’s chores" : "Showing yours and up for grabs"}
      className="tap relative inline-flex items-center rounded-[8px] px-1 text-xs font-semibold text-muted hover:text-text dense:min-h-6"
    >
      {everyone ? "Everyone" : "Mine"}
      <span className="sr-only"> (show {everyone ? "mine" : "everyone’s"})</span>
    </button>
  );
  const body = chores.length ? (
    <SkylightChoreGroups actions={chores} writable={writable} request={write.request} timezone={timezone} now={now} idPrefix={id} compact />
  ) : (
    <p className="py-1 text-sm text-muted">No chores for you today.</p>
  );
  if (variant === "card")
    return (
      <div className="sk-card" data-testid="skylight-chores-card">
        <div className="mb-1 flex items-center justify-between gap-2">
          <p className="text-xs text-muted" data-dynamic>
            {open ? `${open} open today` : "Nothing open today"}
          </p>
          {toggle}
        </div>
        {body}
        {write.node}
      </div>
    );
  return (
    <section aria-labelledby={`${id}-h`} className="mb-5" data-testid="today-chores">
      <SectionLabel
        id={`${id}-h`}
        className="flex-wrap"
        count={open ? String(open) : undefined}
        action={
          <span className="flex items-center gap-1">
            {toggle}
            <Link href="/skylight" className="tap inline-flex items-center rounded-[8px] px-1 text-xs font-semibold text-accent hover:underline dense:min-h-6">
              Skylight<span className="sr-only"> chores</span>
            </Link>
          </span>
        }
      >
        Chores
      </SectionLabel>
      <div>{body}</div>
      {write.node}
    </section>
  );
}
