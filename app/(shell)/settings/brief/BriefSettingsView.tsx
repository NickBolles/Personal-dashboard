"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import {
  AnchoredMenu,
  Banner,
  Button,
  ButtonLink,
  Card,
  Dialog,
  ErrorNote,
  Field,
  Input,
  LoadingState,
  MenuButton,
  PageHeader,
  Pill,
  Toast,
  Toggle,
  useAnchoredMenu,
  useOnline,
  useToast,
} from "@/components/ui";
import type { z } from "zod";
import { BRIEF_LIMITS, BRIEF_NOTE_KIND_LABEL, briefImportSchema, type BriefNoteView, type BriefSettings } from "@/lib/brief";
import { BRIEF_KEY, BRIEF_NOTES_KEY } from "@/components/brief/useBrief";
import "@/components/brief/brief.css";

type SettingsRes = { settings: BriefSettings; ai: { available: boolean; reason?: string } };
type Patch = Partial<Omit<BriefSettings, "share">> & { share?: Partial<BriefSettings["share"]> };
type ImportFile = { name: string; data: z.infer<typeof briefImportSchema> };
/** One pending Undo at a time: what was done, and how to put it back. */
type Undo = { message: string; back: () => Promise<unknown> } | null;
const noteUrl = (id: string) => `/api/brief/notes/${encodeURIComponent(id)}`;

const SHARE: { key: keyof BriefSettings["share"]; label: string }[] = [
  { key: "todos", label: "Todos" },
  { key: "work", label: "Areas and initiatives" },
  { key: "calendar", label: "Calendar" },
  { key: "household", label: "Household" },
  { key: "checkins", label: "Check-ins" },
  { key: "workouts", label: "Workouts" },
  { key: "done", label: "Finished work" },
  { key: "memory", label: "Hermes’ memory of me" },
];

/** Settings → Brief: whether AI writes it, when, what the model may see, and the notes it uses. Controls only; docs/brief.md explains. */
export function BriefSettingsView() {
  const qc = useQueryClient();
  const online = useOnline();
  const { toast } = useToast();
  const menu = useAnchoredMenu();
  const file = useRef<HTMLInputElement>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [buildAt, setBuildAt] = useState<string | null>(null);
  const [forget, setForget] = useState<BriefNoteView | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const [undo, setUndo] = useState<Undo>(null);
  const [incoming, setIncoming] = useState<ImportFile | null>(null);
  const [importing, setImporting] = useState(false);

  // An Undo offer lasts 8 seconds.
  useEffect(() => {
    if (!undo) return;
    const t = window.setTimeout(() => setUndo(null), 8000);
    return () => window.clearTimeout(t);
  }, [undo]);

  const s = useQuery({ queryKey: ["brief", "settings"], queryFn: () => api.get<SettingsRes>("/api/brief/settings") });
  const n = useQuery({ queryKey: BRIEF_NOTES_KEY, queryFn: () => api.get<{ notes: BriefNoteView[] }>("/api/brief/notes") });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: BRIEF_KEY });
  };
  const save = async (patch: Patch) => {
    try {
      const r = await api.put<SettingsRes>("/api/brief/settings", patch);
      qc.setQueryData(["brief", "settings"], r);
      refresh();
    } catch (e) {
      toast((e as Error).message, "danger");
    }
  };
  /** A change to one note: saved, then offered back with Undo. */
  const change = async <T,>(run: () => Promise<T>, message: string, back: (done: T) => Promise<unknown>) => {
    setUndo(null);
    try {
      const done = await run();
      await n.refetch();
      refresh();
      setUndo({ message, back: () => back(done) });
    } catch (e) {
      toast((e as Error).message, "danger");
    }
  };
  const setState = (x: BriefNoteView, state: BriefNoteView["state"], message: string) =>
    change(
      () => api.patch(noteUrl(x.id), { state }),
      message,
      () => api.patch(noteUrl(x.id), { state: x.state }),
    );
  /** A note the model proposed is kept as dismissed, so Undo makes it active again; a person's own note is deleted, so Undo writes it back. */
  const forgetNote = (x: BriefNoteView) =>
    change(
      () => api.del(noteUrl(x.id)),
      "Forgotten",
      () => (x.origin === "learned" ? api.patch(noteUrl(x.id), { state: "active" }) : api.post("/api/brief/notes", { text: x.text, kind: x.kind })),
    );
  /** Import: adds what is missing and can revive a dismissed note, so it is confirmed first and taken back whole by Undo. */
  const runImport = async (file: ImportFile) => {
    setUndo(null);
    try {
      const r = await api.post<{ added: number; skipped: number; undo?: string }>("/api/brief/profile", file.data);
      await n.refetch();
      refresh();
      const message = `Imported ${r.added}${r.skipped ? `, skipped ${r.skipped} already known` : ""}`;
      const token = r.undo;
      if (token) setUndo({ message, back: () => api.post("/api/brief/profile/restore", { token }) });
      else toast(message, "ok");
    } catch (e) {
      toast((e as Error).message, "danger");
    }
  };
  const runUndo = async (u: NonNullable<Undo>) => {
    setUndo(null);
    try {
      await u.back();
      await n.refetch();
      refresh();
    } catch (e) {
      toast((e as Error).message, "danger");
    }
  };

  const settings = s.data?.settings;
  const notes = n.data?.notes ?? [];
  const active = notes.filter((x) => x.state === "active");
  const proposed = notes.filter((x) => x.state === "proposed");

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-5 sm:px-6">
      <PageHeader
        title="Brief"
        actions={
          <ButtonLink href="/brief" size="sm" variant="ghost">
            Open the brief
          </ButtonLink>
        }
      />
      {s.isLoading ? <LoadingState label="Loading brief settings…" /> : null}
      {s.error ? <ErrorNote error={s.error} retry={() => s.refetch()} /> : null}

      {settings ? (
        <>
          <Card title="Writing" meta={`Up to ${BRIEF_LIMITS.buildsPerDay} a day`}>
            <div className="flex flex-col items-start gap-3">
              {!s.data?.ai.available ? <Banner tone="inf">{s.data?.ai.reason}</Banner> : null}
              <Toggle checked={settings.ai} onChange={(ai) => void save({ ai })} label="Written by AI" />
              <Toggle checked={settings.auto} onChange={(auto) => void save({ auto })} label="Ready each morning" locked={!settings.ai} />
              <Field id="brief-build-at" label="Ready by">
                <Input
                  id="brief-build-at"
                  type="time"
                  disabled={!settings.ai || !settings.auto}
                  value={buildAt ?? settings.buildAt}
                  onChange={(e) => setBuildAt(e.target.value)}
                  onBlur={() => {
                    if (buildAt && /^\d{2}:\d{2}$/.test(buildAt) && buildAt !== settings.buildAt) void save({ buildAt });
                    setBuildAt(null);
                  }}
                />
              </Field>
            </div>
          </Card>

          <Card title="Home">
            <div className="flex flex-col">
              <Toggle checked={settings.cycle} onChange={(cycle) => void save({ cycle })} label="Cycle through the cards" />
            </div>
          </Card>
          <Card title="Shared" meta="Never Finance or AI-excluded areas">
            <div className="flex flex-col items-start gap-2">
              {SHARE.map((x) => (
                <Toggle key={x.key} checked={settings.share[x.key]} onChange={(v) => void save({ share: { [x.key]: v } })} label={x.label} />
              ))}
            </div>
          </Card>
        </>
      ) : null}

      <Card
        title="Notes"
        meta={`${active.length} of ${BRIEF_LIMITS.notes}`}
        actions={
          <span {...menu.surfaceProps} className="relative inline-flex">
            <MenuButton menu={menu} label="Import, export or reset notes" />
            <AnchoredMenu
              menu={menu}
              label="Import, export or reset notes"
              items={[
                {
                  label: "Export notes",
                  onSelect: () => {
                    const a = document.createElement("a");
                    a.href = "/api/brief/profile";
                    a.download = "jarvis-brief-profile.json";
                    a.click();
                  },
                },
                { label: "Import notes…", onSelect: () => file.current?.click(), disabled: !online },
                { label: "Forget everything…", danger: true, onSelect: () => setResetOpen(true), disabled: !online },
              ]}
            />
          </span>
        }
      >
        <div className="space-y-3">
          {n.error ? <ErrorNote error={n.error} retry={() => n.refetch()} /> : null}
          {proposed.length ? (
            <ul className="space-y-1.5" aria-label="Proposed by Jarvis">
              {proposed.map((x) => (
                <li key={x.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <Pill tone="prop">{BRIEF_NOTE_KIND_LABEL[x.kind]}</Pill>
                  <span className="min-w-0 flex-1">
                    {x.text}
                    {x.evidence ? <span className="block text-xs text-muted">{x.evidence}</span> : null}
                  </span>
                  <Button size="sm" variant="agent" onClick={() => void setState(x, "active", "Kept")}>
                    Keep<span className="sr-only">: {x.text}</span>
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void setState(x, "dismissed", "Dismissed")}>
                    Not true<span className="sr-only">: {x.text}</span>
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {active.length ? (
            <ul className="divide-y divide-line" aria-label="Notes Jarvis uses">
              {active.map((x) => (
                <li key={x.id} className="flex flex-wrap items-center gap-2 py-1.5 text-sm">
                  <span className="min-w-0 flex-1">{x.text}</span>
                  <Pill tone={x.origin === "learned" ? "ai" : "neutral"}>{BRIEF_NOTE_KIND_LABEL[x.kind]}</Pill>
                  <Button size="sm" variant="ghost" disabled={!online} onClick={() => setForget(x)}>
                    Forget…<span className="sr-only">: {x.text}</span>
                  </Button>
                </li>
              ))}
            </ul>
          ) : n.data ? (
            <p className="text-sm text-muted">No notes yet.</p>
          ) : null}
          <input
            ref={file}
            type="file"
            accept="application/json"
            className="sr-only"
            aria-label="Import brief notes"
            tabIndex={-1}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              let raw: unknown;
              try {
                raw = JSON.parse(await f.text());
              } catch {
                raw = null;
              }
              const parsed = briefImportSchema.safeParse(raw);
              if (!parsed.success) return toast("Choose a brief notes export (JSON)", "danger");
              setIncoming({ name: f.name, data: parsed.data });
            }}
          />
        </div>
      </Card>

      <Dialog
        open={incoming !== null}
        onClose={() => setIncoming(null)}
        title={incoming ? `Import ${incoming.data.notes.length === 1 ? "1 note" : `${incoming.data.notes.length} notes`}?` : "Import notes?"}
        description={incoming?.name}
        footer={
          <>
            <Button variant="ghost" onClick={() => setIncoming(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={importing}
              onClick={async () => {
                if (!incoming) return;
                setImporting(true);
                await runImport(incoming);
                setImporting(false);
                setIncoming(null);
              }}
            >
              Import
            </Button>
          </>
        }
      />

      <Dialog
        open={forget !== null}
        onClose={() => setForget(null)}
        title="Forget this note?"
        description={forget?.text}
        footer={
          <>
            <Button variant="ghost" onClick={() => setForget(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={forgetting}
              onClick={async () => {
                if (!forget) return;
                setForgetting(true);
                await forgetNote(forget);
                setForgetting(false);
                setForget(null);
              }}
            >
              Forget
            </Button>
          </>
        }
      />

      <Dialog
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title="Forget everything the brief knows?"
        description="Your notes, the proposals and your feedback on past briefs are deleted. Briefs already written stay."
        footer={
          <>
            <Button variant="ghost" onClick={() => setResetOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={resetting}
              onClick={async () => {
                setResetting(true);
                await change(
                  () => api.del<{ undo: string }>("/api/brief/profile"),
                  "Forgotten",
                  (done) => api.post("/api/brief/profile/restore", { token: done.undo }),
                );
                setResetting(false);
                setResetOpen(false);
              }}
            >
              Forget everything
            </Button>
          </>
        }
      />

      {undo ? (
        <div className="brief-undo">
          <Toast tone="ok" message={undo.message} action={{ label: "Undo", onClick: () => void runUndo(undo) }} />
        </div>
      ) : null}
    </div>
  );
}
