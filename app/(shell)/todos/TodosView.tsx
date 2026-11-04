"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { NextAction } from "@/lib/contracts";
import { api } from "@/lib/client/api";
import { useSource } from "@/components/useSource";
import { useAccess } from "@/components/access";
import { useSkylightWrite } from "@/components/skylight/useSkylightWrite";
import { SkylightActionRow } from "@/components/skylight/SkylightActionRow";
import type { SkylightExtra } from "@/components/skylight/model";
import { SourceState } from "@/components/SourceState";
import { ActionCard } from "@/components/actions/ActionCard";
import { SourceFilter } from "@/components/actions/SourceFilter";
import { taskSourceLabel } from "@/lib/task-source";
import { Button, Field, PageHeader, Spinner, inputCls, useOnline, useToast } from "@/components/ui";
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
        ? GROUPS.map((g) => {
            const items = actions.filter(g.match);
            // Newest completion first, whichever list it came from.
            if (g.title === "Completed recently") items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
            if (!items.length) return null;
            return (
              <section key={g.title} className="mt-4" aria-labelledby={`g-${g.title.replace(/\W+/g, "-")}`}>
                <SectionHeader id={`g-${g.title.replace(/\W+/g, "-")}`} label={g.title} count={items.length} />
                <ul className="jv-feed">
                  {items.map((a) => (
                    <li key={a.id} id={a.source === "todos" ? `todo-${a.sourceId}` : undefined}>
                      {a.source === "skylight" ? (
                        <SkylightActionRow action={a} writable={writable} request={write.request} />
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
