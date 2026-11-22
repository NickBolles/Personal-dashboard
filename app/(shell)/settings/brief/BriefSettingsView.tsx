"use client";

import { useRef, useState } from "react";
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
  Toggle,
  useAnchoredMenu,
  useOnline,
  useToast,
} from "@/components/ui";
import { BRIEF_LIMITS, BRIEF_NOTE_KIND_LABEL, briefImportSchema, type BriefNoteView, type BriefSettings } from "@/lib/brief";
import { BRIEF_KEY, BRIEF_NOTES_KEY } from "@/components/brief/useBrief";

type SettingsRes = { settings: BriefSettings; ai: { available: boolean; reason?: string } };
type Patch = Partial<Omit<BriefSettings, "share">> & { share?: Partial<BriefSettings["share"]> };

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
  const note = async (run: () => Promise<unknown>, ok: string) => {
    try {
      await run();
      toast(ok, "ok");
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
                  <Button
                    size="sm"
                    variant="agent"
                    onClick={() => void note(() => api.patch(`/api/brief/notes/${x.id}`, { state: "active" }).then(() => n.refetch()), "Kept")}
                  >
                    Keep<span className="sr-only">: {x.text}</span>
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void note(() => api.patch(`/api/brief/notes/${x.id}`, { state: "dismissed" }).then(() => n.refetch()), "Dismissed")}
                  >
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
                  <Button size="sm" variant="ghost" onClick={() => void note(() => api.del(`/api/brief/notes/${x.id}`).then(() => n.refetch()), "Forgotten")}>
                    Forget<span className="sr-only">: {x.text}</span>
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
              await note(async () => {
                const r = await api.post<{ added: number; skipped: number }>("/api/brief/profile", parsed.data);
                toast(`Imported ${r.added}${r.skipped ? `, skipped ${r.skipped} already known` : ""}`, "ok");
                await n.refetch();
              }, "Import finished");
            }}
          />
        </div>
      </Card>

      <Dialog
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title="Forget everything the brief knows?"
        description="Your notes, the proposals and your feedback on past briefs are deleted. This can't be undone; export first if you want a copy. Briefs already written stay."
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
                await note(() => api.del("/api/brief/profile").then(() => n.refetch()), "Forgotten");
                setResetting(false);
                setResetOpen(false);
              }}
            >
              Forget everything
            </Button>
          </>
        }
      />
    </div>
  );
}
