"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { NextAction } from "@/lib/contracts";
import { api } from "@/lib/client/api";
import { useSource } from "@/components/useSource";
import { useAccess } from "@/components/access";
import { useSkylightWrite } from "@/components/skylight/useSkylightWrite";
import { SkylightActionRow } from "@/components/skylight/SkylightActionRow";
import { groupSkylightChores } from "@/components/skylight/grouping";
import type { SkylightExtra } from "@/components/skylight/model";
import { SourceState } from "@/components/SourceState";
import { ActionCard } from "@/components/actions/ActionCard";
import { SourceFilter } from "@/components/actions/SourceFilter";
import { taskSourceLabel } from "@/lib/task-source";
import { Button, Field, PageHeader, Spinner, inputCls, useNow, useOnline, useToast } from "@/components/ui";
import { ChipSelect, EmptyState, SectionHeader } from "@/components/ui/kit";

const GROUPS: { title: string; match: (a: NextAction) => boolean }[] = [
  { title: "Overdue", match: (a) => a.status === "open" && a.priorityReason === "overdue" },
  { title: "Today", match: (a) => a.status === "open" && ["due_soon", "today"].includes(a.priorityReason) },
  { title: "Upcoming & undated", match: (a) => a.status === "open" && a.priorityReason === "upcoming" },
  { title: "Completed recently", match: (a) => a.status === "completed" },
];

/** Todos' source chip: every Skylight chore (mine, up for grabs) files under one "Skylight" option. */
const todoSourceLabel = (a: NextAction) =>
  a.source === "skylight" ? (a.skylight?.kind === "list_item" ? a.sourceLabel || `Skylight · ${a.skylight.listLabel}` : "Skylight") : taskSourceLabel(a);

export function TodosView() {
  const q = useSource("todos");
  // Skylight chores and lists keep their upstream identity beside the canonical list.
  const sky = useSource("skylight");
  const { can } = useAccess();
  const write = useSkylightWrite();
  const now = useNow();
  const prefs = useQuery({ queryKey: ["preferences"], queryFn: () => api.get<{ timezone: string }>("/api/settings") });
  const timezone = prefs.data?.timezone || "America/Chicago";
  const extra = (sky.data?.data?.extra ?? {}) as SkylightExtra;
  const writable = extra.writable === true && can("skylight.write");
  const provider = (q.data?.data?.extra?.provider as string | undefined) ?? undefined;
  const all = useMemo(
    () => [...(q.data?.data?.actions ?? []), ...(sky.data?.data?.actions ?? []), ...((sky.data?.data?.extra as SkylightExtra | undefined)?.listItems ?? [])],
    [q.data, sky.data],
  );
  const [source, setSource] = useState("");
  const [whose, setWhose] = useState("mine");
  const options = useMemo(() => [...new Set(all.map(todoSourceLabel))].sort((a, b) => a.localeCompare(b)), [all]);
  const actions = all.filter(
    (a) => (!source || todoSourceLabel(a) === source) && (whose === "everyone" || a.source !== "skylight" || a.assignee?.kind !== "other"),
  );
  // Skylight chores follow Skylight's own order (time of day today, later days, past days last); everything else
  // keeps the due-state groups. Overdue — native and Skylight alike — sits at the bottom, above Completed.
  const isChore = (a: NextAction) => a.source === "skylight" && a.skylight?.kind === "chore" && a.status === "open";
  const chores = groupSkylightChores(actions, { now, timezone });
  const choreBucket = (key: string) => chores.find((c) => c.key === key)?.actions ?? [];
  const native = (title: string) => actions.filter((a) => !isChore(a) && GROUPS.find((g) => g.title === title)!.match(a));
  const completed = native("Completed recently").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const groups: { title: string; items: NextAction[] }[] = [
    { title: "Today", items: native("Today") },
    ...chores.filter((c) => c.key !== "later" && c.key !== "overdue").map((c) => ({ title: `Skylight · ${c.label}`, items: c.actions })),
    { title: "Upcoming & undated", items: [...native("Upcoming & undated"), ...choreBucket("later")] },
    { title: "Overdue", items: [...native("Overdue"), ...choreBucket("overdue")] },
    // Newest completion first, whichever list it came from.
    { title: "Completed recently", items: completed },
  ];
  return (
    <div className="mx-auto max-w-3xl px-4 py-5 sm:px-6">
      <PageHeader
        title="Todos"
        subtitle={
          provider ? `Canonical list: ${provider === "google_tasks" ? "Google Tasks" : provider === "home_assistant" ? "Home Assistant" : "Jarvis"}` : undefined
        }
      />
      {q.isLoading ? <Spinner label="Loading todos…" /> : null}
      <SourceState status={q.data?.status} hasData={Boolean(q.data?.data)} />
      {provider === "jarvis" ? <AddTodo /> : null}
      <SourceFilter options={options} value={source} onChange={setSource} />
      <ChipSelect aria-label="Whose" className="mt-2 w-36 [&>select]:w-full" value={whose} onChange={(e) => setWhose(e.target.value)} active={whose !== "mine"}>
        <option value="mine">Mine</option>
        <option value="everyone">Everyone</option>
      </ChipSelect>
      {q.data?.data || sky.data?.data
        ? groups.map((g) => {
            const items = g.items;
            if (!items.length) return null;
            return (
              <section key={g.title} className="mt-4" aria-labelledby={`g-${g.title.replace(/\W+/g, "-")}`}>
                <SectionHeader id={`g-${g.title.replace(/\W+/g, "-")}`} label={g.title} count={items.length} />
                <ul className="jv-feed">
                  {items.map((a) => (
                    // Skylight rows wrap only when they can't fit (320 px at 200% text: checkbox + icon actions + ⋯).
                    <li
                      key={a.id}
                      id={a.source === "todos" ? `todo-${a.sourceId}` : undefined}
                      className={a.source === "skylight" ? "[&>.jv-trow]:flex-wrap" : undefined}
                    >
                      {a.source === "skylight" ? (
                        <SkylightActionRow action={a} writable={writable} request={write.request} timezone={timezone} />
                      ) : (
                        <ActionCard action={a} compact={a.status === "completed"} quiet row />
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })
        : null}
      {write.node}
      {(q.data?.data || sky.data?.data) && !actions.length ? (
        <div className="mt-6">
          <EmptyState title="No open todos." />
        </div>
      ) : null}
    </div>
  );
}

function AddTodo() {
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const online = useOnline();
  const qc = useQueryClient();
  const { toast } = useToast();
  return (
    <form
      className="card mt-2 flex flex-wrap items-end gap-2 p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!title.trim()) return;
        setBusy(true);
        try {
          await api.post("/api/todos", { title: title.trim(), due: due || undefined });
          setTitle("");
          setDue("");
          qc.invalidateQueries({ queryKey: ["source", "todos"] });
          qc.invalidateQueries({ queryKey: ["home"] });
        } catch (err) {
          toast((err as Error).message, "danger");
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="min-w-48 flex-1">
        <Field id="new-todo" label="New todo">
          <input id="new-todo" className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
      </div>
      <Field id="new-todo-due" label="Due">
        <input id="new-todo-due" type="date" className={inputCls} value={due} onChange={(e) => setDue(e.target.value)} />
      </Field>
      <Button type="submit" variant="primary" busy={busy} disabled={!online}>
        Add
      </Button>
    </form>
  );
}
