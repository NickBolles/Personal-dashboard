"use client";

import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { Button, ButtonLink, Page, PageHeader, useToast } from "@/components/ui";

type Summary = {
  id: string;
  slug: string;
  name: string;
  icon: string;
  status: "draft" | "active" | "archived";
  currentVersion: number;
  area: string | null;
  description: string | null;
  triggers: string[];
};
type BuiltIn = { kind: string; slug: string; name: string; description: string; href: string };
type ImportResult =
  { ok: true; slug: string; duplicate: boolean; areaFound: boolean } | { ok: false; code: string; issues: { path: string; message: string }[] };

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Workflows gallery (W1): your workflows + read-only built-ins; import (as draft) / export JSON; activate. */
export function WorkflowsGallery() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const file = useRef<HTMLInputElement>(null);
  const [report, setReport] = useState<ImportResult[] | null>(null);
  const q = useQuery({ queryKey: ["workflows"], queryFn: ({ signal }) => api.get<{ workflows: Summary[]; builtIns: BuiltIn[] }>("/api/workflows", signal) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["workflows"] });

  const onImport = async (f: File | undefined) => {
    if (!f) return;
    try {
      const text = await f.text();
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        toast("That file isn't JSON.", "danger");
        return;
      }
      const res = await api.post<{ results: ImportResult[] }>("/api/workflows/import", { data });
      setReport(res.results);
      await refresh();
    } catch (err) {
      toast((err as Error).message, "danger");
    } finally {
      if (file.current) file.current.value = "";
    }
  };
  const exportAll = async (id?: string) => {
    try {
      const data = await api.get(`/api/workflows/export${id ? `?id=${encodeURIComponent(id)}` : ""}`);
      download(id ? `workflow-${id}.json` : "jarvis-workflows.json", data);
    } catch (err) {
      toast((err as Error).message, "danger");
    }
  };
  const setStatus = async (w: Summary, status: Summary["status"]) => {
    try {
      await api.patch(`/api/workflows/${encodeURIComponent(w.id)}`, { status });
      toast(status === "active" ? `${w.name} is on. Type /${w.slug} in search to start it.` : `${w.name} archived.`, "ok");
      await refresh();
    } catch (err) {
      toast((err as Error).message, "danger");
    }
  };

  const mine = q.data?.workflows ?? [];
  return (
    <Page width="medium">
      <PageHeader
        title="Workflows"
        subtitle="Reusable chats with their own instructions."
        actions={
          <div className="flex flex-wrap gap-2">
            <ButtonLink href="/workflows/new" variant="primary">
              New workflow
            </ButtonLink>
            <Button onClick={() => file.current?.click()}>Import JSON</Button>
            <Button onClick={() => void exportAll()} disabled={!mine.length}>
              Export all
            </Button>
          </div>
        }
      />
      <input
        ref={file}
        type="file"
        accept="application/json,.json"
        className="sr-only"
        aria-label="Workflow JSON file"
        onChange={(e) => void onImport(e.target.files?.[0])}
      />

      {report ? (
        <section aria-label="Import result" role="status" className="card mb-4 p-3">
          <ul className="space-y-1 text-sm">
            {report.map((r, i) =>
              r.ok ? (
                <li key={i}>
                  {r.duplicate ? `/${r.slug} is already here (same definition).` : `Imported /${r.slug} as a draft.`}
                  {r.areaFound ? "" : " Its area wasn't found, so chats will land in Miscellaneous."}
                </li>
              ) : (
                <li key={i} className="text-danger">
                  Not imported: {r.issues.map((x) => x.message).join("; ")}
                </li>
              ),
            )}
          </ul>
          <Button size="sm" className="mt-2" onClick={() => setReport(null)}>
            Dismiss
          </Button>
        </section>
      ) : null}

      <h2 className="mb-2 text-sm font-semibold">Your workflows</h2>
      {q.isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : q.isError ? (
        <p className="text-sm text-danger">Couldn&apos;t load workflows.</p>
      ) : mine.length === 0 ? (
        <div className="card mb-6 p-4 text-sm">
          <p className="font-semibold">No workflows yet</p>
          <p className="text-muted">Import a workflow JSON file to add one. It arrives as a draft until you turn it on.</p>
        </div>
      ) : (
        <ul className="mb-6 grid grid-cols-1 gap-2 sm:grid-cols-2" aria-label="Your workflows">
          {mine.map((w) => (
            <li key={w.id} className="card flex min-w-0 flex-col gap-2 p-3" data-testid="workflow-card">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h3 className="min-w-0 font-semibold break-words">{w.name}</h3>
                <span className="rounded-full border border-line px-2 text-xs">
                  {w.status === "active" ? "On" : w.status === "draft" ? "Draft" : "Archived"}
                </span>
                <span className="text-xs text-muted">v{w.currentVersion}</span>
              </div>
              {w.description ? <p className="text-sm break-words text-muted">{w.description}</p> : null}
              <p className="text-xs break-words text-muted">
                {w.area ? `Files under ${w.area}` : "Files in the current area"} · {w.triggers.join(" · ") || "no triggers"}
              </p>
              <div className="flex flex-wrap gap-2">
                {w.status !== "active" ? (
                  <Button size="sm" variant="primary" onClick={() => void setStatus(w, "active")}>
                    Turn on {w.name}
                  </Button>
                ) : null}
                <ButtonLink size="sm" href={`/workflows/${w.slug}`} aria-label={`History for ${w.name}`}>
                  History
                </ButtonLink>
                <ButtonLink size="sm" href={`/workflows/${w.slug}/edit`} aria-label={`Edit ${w.name}`}>
                  Edit
                </ButtonLink>
                <Button size="sm" onClick={() => void exportAll(w.id)} aria-label={`Export ${w.name}`}>
                  Export
                </Button>
                {w.status !== "archived" ? (
                  <Button size="sm" onClick={() => void setStatus(w, "archived")} aria-label={`Archive ${w.name}`}>
                    Archive
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      <h2 className="mb-2 text-sm font-semibold">Built in</h2>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2" aria-label="Built-in workflows">
        {(q.data?.builtIns ?? []).map((b) => (
          <li key={b.kind} className="card flex min-w-0 flex-col gap-1 p-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 className="font-semibold">{b.name}</h3>
              <span className="rounded-full border border-line px-2 text-xs">Built in</span>
            </div>
            <p className="text-sm break-words text-muted">{b.description}</p>
          </li>
        ))}
      </ul>
    </Page>
  );
}
