"use client";

import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { Button, Dialog, cx, inputCls, useToast } from "@/components/ui";
import { displayValue } from "@/lib/workflows/runs";
import type { RunPanelView } from "./RunPanel";

/**
 * Workflows W4 run outputs (catalog parts SummaryCard · ExportBar ·
 * ActionChecklist · ReflectionPrompt, plus the Edit session and end forms).
 * Writes outside the run (work items) go through an explicit confirm sheet
 * listing the exact titles, destination and due date. Markdown is local.
 */

type Field = { id: string; bind: string; type: string; label: string; help?: string; maxLength?: number; min?: number; max?: number; step?: number };
type Promoted = { index: number; itemId: string; title: string };
export type RunOutputsView = RunPanelView & {
  areaId?: string | null;
  areaTitle?: string | null;
  startedAt?: string;
  summary?: string | null;
  summaryState?: "none" | "proposed" | "accepted";
  promoted?: Promoted[];
  definition: RunPanelView["definition"] & { mid?: Field[]; end?: Field[]; reflectionPrompts?: string; name?: string };
};

const runUrl = (id: string, rest = "") => `/api/workflows/runs/${encodeURIComponent(id)}${rest}`;

function useSetRun(sessionId: string) {
  const qc = useQueryClient();
  return (r: RunOutputsView) => qc.setQueryData(["workflow-run", sessionId], r);
}

function current(run: RunOutputsView, f: Field): unknown {
  const [a, b] = f.bind.split(".");
  const v = b ? ((run.capture[a] ?? {}) as Record<string, unknown>)[b] : run.capture[a];
  // typed fields keep their type (number/toggle/tags, #147/#148); everything else edits as text
  if (f.type === "number") return typeof v === "number" ? v : null;
  if (f.type === "toggle") return v === true;
  if (f.type === "tags") return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  return displayValue(v);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const blank = (v: unknown) => v === null || v === undefined || v === false || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length);

/** Type-aware control for Edit session / end form fields (number, toggle, tags keep their type). */
function TypedField({ f, value, set, error, multiline }: { f: Field; value: unknown; set: (v: unknown) => void; error?: string; multiline?: boolean }) {
  const id = useId();
  const [draft, setDraft] = useState("");
  const errId = error ? `${id}-err` : undefined;
  const help = f.help ? <span className="text-xs text-muted">{f.help}</span> : null;
  const err = error ? (
    <span id={errId} className="block text-xs text-danger">
      {error}
    </span>
  ) : null;
  if (f.type === "toggle")
    return (
      <div className="block text-sm">
        <label className="flex min-h-11 items-center gap-3">
          <input type="checkbox" className="h-5 w-5 shrink-0" checked={value === true} onChange={(e) => set(e.target.checked)} aria-describedby={errId} />
          <span className="font-medium">{f.label}</span>
        </label>
        {help}
        {err}
      </div>
    );
  if (f.type === "tags") {
    const tags = Array.isArray(value) ? (value as string[]) : [];
    const add = () => {
      const t = draft.trim().replace(/,$/, "");
      if (t && !tags.includes(t) && tags.length < (f.max ?? 8)) set([...tags, t]);
      setDraft("");
    };
    return (
      <div className="block text-sm">
        <label htmlFor={id} className="mb-1 block font-medium">
          {f.label}
        </label>
        {tags.length ? (
          <div className="mb-1 flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <Button type="button" key={t} size="sm" variant="ghost" aria-label={`Remove tag ${t}`} onClick={() => set(tags.filter((x) => x !== t))}>
                {t} ×
              </Button>
            ))}
          </div>
        ) : null}
        <input
          id={id}
          type="text"
          className={cx(inputCls, "w-full")}
          value={draft}
          placeholder="Type a tag, then Enter"
          aria-describedby={errId}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            }
          }}
          onBlur={add}
        />
        {help}
        {err}
      </div>
    );
  }
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{f.label}</span>
      {f.type === "number" ? (
        <input
          className={cx(inputCls, "w-full")}
          type="number"
          inputMode="decimal"
          min={f.min}
          max={f.max}
          step={f.step ?? "any"}
          value={value === null || value === undefined ? "" : String(value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={errId}
          onChange={(e) => set(e.target.value === "" ? null : Number(e.target.value))}
        />
      ) : multiline || f.type === "longtext" ? (
        <textarea
          rows={3}
          maxLength={f.maxLength ?? 4000}
          className={cx(inputCls, "w-full")}
          value={typeof value === "string" ? value : ""}
          aria-invalid={error ? true : undefined}
          aria-describedby={errId}
          onChange={(e) => set(e.target.value)}
        />
      ) : (
        <input
          className={cx(inputCls, "w-full")}
          type={f.type === "datetime" ? "datetime-local" : f.type === "date" ? "date" : "text"}
          maxLength={f.maxLength}
          value={typeof value === "string" ? value : ""}
          aria-invalid={error ? true : undefined}
          aria-describedby={errId}
          onChange={(e) => set(e.target.value)}
        />
      )}
      {help}
      {err}
    </label>
  );
}

/** #132 Edit session: scalar mid-form fields only (list items are edited in the outline). */
export function EditSessionDialog({ sessionId, run, onClose }: { sessionId: string; run: RunOutputsView; onClose: () => void }) {
  const fields = (run.definition.mid ?? []).filter((f) => !f.bind.endsWith("/-"));
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(fields.map((f) => [f.id, current(run, f)])));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formId = useId();
  const set = useSetRun(sessionId);
  const { toast } = useToast();
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const changed = Object.fromEntries(fields.filter((f) => !same(values[f.id], current(run, f))).map((f) => [f.id, values[f.id]]));
      const r = await api.patch<{ run: RunOutputsView; applied: string[] }>(runUrl(run.id, "/session"), { values: changed });
      set(r.run);
      toast(r.applied.length ? "Session updated" : "No changes", "ok");
      onClose();
    } catch (e) {
      // the dialog stays open with the owner's edits so nothing is lost (#148)
      setError((e as Error).message);
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Edit session"
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" busy={busy} data-testid="workflow-edit-save">
            Save
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="space-y-3"
        aria-label="Edit session"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {fields.map((f) => (
          <TypedField key={f.id} f={f} value={values[f.id]} set={(x) => setValues((v) => ({ ...v, [f.id]: x }))} />
        ))}
        {error ? (
          <p role="alert" className="text-sm text-danger" data-testid="workflow-form-error">
            {error}
          </p>
        ) : null}
        <p className="text-xs text-muted">Scripture, points and other notes are edited in the outline.</p>
      </form>
    </Dialog>
  );
}

/** End form (definition `forms.end`) shown before ending; values are filed into the run, then it ends. */
export function EndSessionDialog({ sessionId, run, onClose }: { sessionId: string; run: RunOutputsView; onClose: () => void }) {
  const fields = run.definition.end ?? [];
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formId = useId();
  const set = useSetRun(sessionId);
  const { toast } = useToast();
  const end = async () => {
    setBusy(true);
    setError(null);
    try {
      // toggles send false only when the owner turned them on and back off; untouched = not answered
      const toggles = new Set(fields.filter((f) => f.type === "toggle").map((f) => f.id));
      const filled = Object.fromEntries(Object.entries(values).filter(([k, v]) => !blank(v) || (v === false && toggles.has(k))));
      const r = await api.post<RunOutputsView>(runUrl(run.id, "/end"), Object.keys(filled).length ? { values: filled } : {});
      set({ ...run, ...r });
      toast("Session ended", "ok");
      onClose();
    } catch (e) {
      // #147: the session is NOT ended when answers can't be filed; keep the dialog open with them
      setError((e as Error).message);
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Before you go"
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Keep taking notes
          </Button>
          <Button type="submit" form={formId} variant="primary" busy={busy} data-testid="workflow-end-submit">
            End session
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="space-y-3"
        aria-label="End session"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void end();
        }}
      >
        {fields.map((f) => (
          <TypedField key={f.id} f={f} multiline value={values[f.id]} set={(x) => setValues((v) => ({ ...v, [f.id]: x }))} />
        ))}
        {error ? (
          <p role="alert" className="text-sm text-danger" data-testid="workflow-form-error">
            {error}
          </p>
        ) : null}
        <p className="text-xs text-muted">Optional. Ending never changes any item.</p>
      </form>
    </Dialog>
  );
}

/** End-of-session summary: the agent drafts (dashed proposal); the owner accepts, edits or discards. */
export function SummaryCard({ sessionId, run }: { sessionId: string; run: RunOutputsView }) {
  const set = useSetRun(sessionId);
  const { toast } = useToast();
  const [busy, setBusy] = useState<"draft" | "save" | null>(null);
  const [text, setText] = useState<string | null>(null);
  const state = run.summaryState ?? "none";
  const draft = async () => {
    setBusy("draft");
    try {
      const r = await api.post<RunOutputsView>(runUrl(run.id, "/summary"));
      set({ ...run, ...r });
      setText(r.summary ?? "");
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(null);
    }
  };
  const save = async (summary: string | null) => {
    setBusy("save");
    try {
      const r = await api.put<RunOutputsView>(runUrl(run.id, "/summary"), { summary });
      set({ ...run, ...r });
      setText(null);
      toast(summary ? "Summary saved" : "Summary discarded", "ok");
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(null);
    }
  };
  const counts = Object.entries(run.definition.capture)
    .filter(([, e]) => e.type === "list")
    .map(([k]) => `${k.charAt(0).toUpperCase()}${k.slice(1)} ${Array.isArray(run.capture[k]) ? (run.capture[k] as unknown[]).length : 0}`);
  const editing = text !== null || state === "proposed";
  return (
    <section className="rounded-lg border border-line p-3" aria-labelledby={`sum-${run.id}`} data-testid="workflow-summary">
      <h3 id={`sum-${run.id}`} className="text-sm font-semibold">
        Summary
      </h3>
      <p className="text-xs text-muted" data-dynamic>
        {counts.join(" · ")}
      </p>
      {state === "accepted" && !editing ? (
        <div className="mt-2 space-y-2">
          <p className="whitespace-pre-wrap break-words text-sm">{run.summary}</p>
          <Button size="sm" variant="ghost" onClick={() => setText(run.summary ?? "")}>
            Edit summary
          </Button>
        </div>
      ) : editing ? (
        <div className="mt-2 space-y-2 rounded-lg border border-dashed border-accent p-2">
          <label className="block text-sm">
            <span className="mb-1 block text-xs text-muted">{state === "proposed" ? "Suggested summary — check it before saving" : "Summary"}</span>
            <textarea
              rows={5}
              maxLength={4000}
              className={cx(inputCls, "w-full")}
              value={text ?? run.summary ?? ""}
              onChange={(e) => setText(e.target.value)}
              data-testid="workflow-summary-text"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" busy={busy === "save"} onClick={() => void save((text ?? run.summary ?? "").trim() || null)}>
              Accept summary
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void save(null)}>
              Discard
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-2">
          <Button size="sm" busy={busy === "draft"} onClick={() => void draft()} data-testid="workflow-summary-draft">
            Draft a summary
          </Button>
          <p className="mt-1 text-xs text-muted">Jarvis suggests one from your notes; nothing is saved until you accept it.</p>
        </div>
      )}
    </section>
  );
}

/** Export bar: Markdown download + copy are local. Drive needs a Drive connection (not set up yet). */
export function ExportBar({ run }: { run: RunOutputsView }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const get = () => api.get<{ fileName: string; markdown: string }>(runUrl(run.id, "/export"));
  const download = async () => {
    setBusy(true);
    try {
      const { fileName, markdown } = await get();
      const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    try {
      const { markdown } = await get();
      await navigator.clipboard.writeText(markdown);
      toast("Copied as Markdown", "ok");
    } catch (e) {
      toast((e as Error).message || "Couldn't copy", "danger");
    }
  };
  return (
    <section className="rounded-lg border border-line p-3" aria-label="Export" data-testid="workflow-export">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" busy={busy} onClick={() => void download()}>
          Download Markdown
        </Button>
        <Button size="sm" onClick={() => void copy()}>
          Copy
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted">Save to Google Drive isn&apos;t available yet: Jarvis has no Drive connection.</p>
    </section>
  );
}

/** Action checklist → "Create N items?" confirm sheet → existing work-item create (confirmed). */
export function ActionChecklist({ sessionId, run }: { sessionId: string; run: RunOutputsView }) {
  const rows = Array.isArray(run.capture.actions) ? (run.capture.actions as unknown[]) : [];
  const done = new Map((run.promoted ?? []).map((p) => [p.index, p]));
  const [picked, setPicked] = useState<number[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [parent, setParent] = useState<string>(run.areaId ?? "");
  const set = useSetRun(sessionId);
  const { toast } = useToast();
  // Destination: the run's area by default; any area can be picked in the confirm sheet.
  const areas = useQuery({
    queryKey: ["work-items"],
    queryFn: ({ signal }) => api.get<{ items: { id: string; title: string; kind: string; archived?: boolean }[] }>("/api/work/items", signal),
    enabled: confirming,
    select: (r) => r.items.filter((i) => i.kind === "area" && !i.archived),
  });
  if (!run.definition.capture.actions || !rows.length) return null;
  const plan = picked
    .filter((i) => !done.has(i))
    .map((i) => ({ index: i, title: displayValue(rows[i]).trim().slice(0, 200) }))
    .filter((p) => p.title);
  const create = async () => {
    if (!parent) return;
    setBusy(true);
    try {
      const r = await api.post<{ run: RunOutputsView; created: Promoted[]; already?: Promoted[] }>(runUrl(run.id, "/promote"), {
        indices: plan.map((p) => p.index),
        parentId: parent,
        due: due || null,
        titles: plan.map((p) => p.title),
      });
      set({ ...run, ...r.run });
      setPicked([]);
      setConfirming(false);
      // #145: a second confirm (other tab / retry) creates nothing and says so
      const already = r.already?.length ?? 0;
      toast(
        !r.created.length
          ? "Already created"
          : `${r.created.length === 1 ? "Created 1 item" : `Created ${r.created.length} items`}${already ? ` · ${already} already created` : ""}`,
        "ok",
      );
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="rounded-lg border border-line p-3" aria-labelledby={`act-${run.id}`} data-testid="workflow-actions">
      <h3 id={`act-${run.id}`} className="text-sm font-semibold">
        Actions
      </h3>
      <ul className="mt-1 space-y-1">
        {rows.map((v, i) => {
          const p = done.get(i);
          return (
            <li key={i} className="flex min-w-0 items-center gap-2 text-sm">
              <input
                id={`act-${run.id}-${i}`}
                type="checkbox"
                className="h-5 w-5 shrink-0"
                disabled={!!p}
                checked={!!p || picked.includes(i)}
                onChange={(e) => setPicked((old) => (e.target.checked ? [...old, i] : old.filter((x) => x !== i)))}
              />
              <label htmlFor={`act-${run.id}-${i}`} className="min-w-0 flex-1 break-words">
                {displayValue(v)}
              </label>
              {p ? <span className="shrink-0 text-xs text-muted">Item created</span> : null}
            </li>
          );
        })}
      </ul>
      <Button size="sm" className="mt-2" disabled={!plan.length} onClick={() => setConfirming(true)} data-testid="workflow-actions-create">
        {plan.length === 1 ? "Create 1 item" : `Create ${plan.length} items`}
      </Button>
      {confirming ? (
        <Dialog
          open
          onClose={() => setConfirming(false)}
          title={plan.length === 1 ? "Create 1 item?" : `Create ${plan.length} items?`}
          footer={
            <>
              <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button variant="primary" busy={busy} disabled={!parent} onClick={() => void create()} data-testid="workflow-actions-confirm">
                Create
              </Button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            <ul className="list-disc space-y-1 pl-5" aria-label="Items to create">
              {plan.map((p) => (
                <li key={p.index} className="break-words">
                  {p.title}
                </li>
              ))}
            </ul>
            <label className="block">
              <span className="mb-1 block">Destination</span>
              <select className={cx(inputCls, "w-full")} value={parent} onChange={(e) => setParent(e.target.value)} data-testid="workflow-actions-parent">
                {!parent ? <option value="">Pick an area</option> : null}
                {run.areaId && !(areas.data ?? []).some((a) => a.id === run.areaId) ? <option value={run.areaId}>{run.areaTitle ?? "This area"}</option> : null}
                {(areas.data ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block">Due (optional)</span>
              <input type="date" className={cx(inputCls, "w-full")} value={due} onChange={(e) => setDue(e.target.value)} />
            </label>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}

/** "Prompt me" (D10): one reflection question from this run's notes; Answer files it into reflections. */
export function ReflectionPrompt({ sessionId, run }: { sessionId: string; run: RunOutputsView }) {
  const [prompt, setPrompt] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const set = useSetRun(sessionId);
  const { toast } = useToast();
  if (!run.definition.reflectionPrompts || run.definition.reflectionPrompts === "off" || run.status !== "live" || !run.definition.capture.reflections)
    return null;
  const ask = async () => {
    setBusy(true);
    try {
      setPrompt((await api.post<{ prompt: string }>(runUrl(run.id, "/reflection"))).prompt);
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };
  const file = async () => {
    try {
      const r = await api.patch<{ run: RunOutputsView }>(runUrl(run.id), {
        by: "user",
        ops: [{ op: "add", path: "/reflections/-", value: answer.trim() }],
        source: "edit",
      });
      set({ ...run, ...r.run });
      setPrompt(null);
      setAnswer("");
    } catch (e) {
      toast((e as Error).message, "danger");
    }
  };
  if (!prompt)
    return (
      <button
        type="button"
        className="tap min-h-11 rounded-full border border-dashed border-accent px-3 text-sm sm:min-h-9"
        onClick={() => void ask()}
        disabled={busy}
        data-testid="workflow-prompt-me"
      >
        {busy ? "Thinking…" : "Prompt me"}
      </button>
    );
  return (
    <div
      className="mt-2 rounded-lg border border-dashed border-accent p-2 text-sm"
      role="group"
      aria-label="Reflection prompt"
      data-testid="workflow-reflection"
    >
      <p className="break-words">{prompt}</p>
      <label className="mt-2 block">
        <span className="sr-only">Your answer</span>
        <textarea rows={2} className={cx(inputCls, "w-full")} value={answer} onChange={(e) => setAnswer(e.target.value)} />
      </label>
      <div className="mt-1 flex flex-wrap gap-2">
        <Button size="sm" variant="primary" disabled={!answer.trim()} onClick={() => void file()}>
          Answer
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setPrompt(null)}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
