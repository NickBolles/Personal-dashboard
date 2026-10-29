"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { NextAction } from "@/lib/contracts";
import { api } from "@/lib/client/api";
import { useSource } from "@/components/useSource";
import { SourceState } from "@/components/SourceState";
import { ActionCard } from "@/components/actions/ActionCard";
import { SourceFilter, matchesSource } from "@/components/actions/SourceFilter";
import { Button, Field, PageHeader, Spinner, inputCls, useOnline, useToast } from "@/components/ui";
import { EmptyState, SectionHeader } from "@/components/ui/kit";

const GROUPS: { title: string; match: (a: NextAction) => boolean }[] = [
  { title: "Overdue", match: (a) => a.status === "open" && a.priorityReason === "overdue" },
  { title: "Today", match: (a) => a.status === "open" && ["due_soon", "today"].includes(a.priorityReason) },
  { title: "Upcoming & undated", match: (a) => a.status === "open" && a.priorityReason === "upcoming" },
  { title: "Completed recently", match: (a) => a.status === "completed" },
];

export function TodosView() {
  const q = useSource("todos");
  const provider = (q.data?.data?.extra?.provider as string | undefined) ?? undefined;
  const all = q.data?.data?.actions ?? [];
  const [source, setSource] = useState("");
  const actions = all.filter(matchesSource(source));
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
      <SourceFilter items={all} value={source} onChange={setSource} />
      {q.data?.data
        ? GROUPS.map((g) => {
            const items = actions.filter(g.match);
            if (!items.length) return null;
            return (
              <section key={g.title} className="mt-4" aria-labelledby={`g-${g.title}`}>
                <SectionHeader id={`g-${g.title}`} label={g.title} count={items.length} />
                <ul className="space-y-2">
                  {items.map((a) => (
                    <li key={a.id} id={`todo-${a.sourceId}`}>
                      <ActionCard action={a} compact={a.status === "completed"} quiet />
                    </li>
                  ))}
                </ul>
              </section>
            );
          })
        : null}
      {q.data?.data && !actions.length ? (
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
