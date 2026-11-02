"use client";

import { useEffect, useMemo, useReducer, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { Button, Field, Page, PageHeader, useToast } from "@/components/ui";
import { FIELD_TYPES, MODEL_TIERS, WORKFLOW_ICONS, formFields, type WorkflowDefinition, type WorkflowField } from "@/lib/workflows/definition";
import {
  BUILDER_SECTIONS,
  builderReducer,
  initBuilder,
  issuesBySection,
  sourceOfDefault,
  tokenCount,
  type BuilderSection,
  type DefaultSource,
  type FormSlot,
} from "@/lib/workflows/builder";
import type { DiffChange } from "@/lib/workflows/versions";

type Detail = {
  workflow: { id: string; slug: string; name: string; currentVersion: number; status: string };
  definition: WorkflowDefinition;
  versions: { version: number; createdAt: string; changeNote: string | null }[];
};

const SECTION_LABEL: Record<BuilderSection, string> = {
  basics: "Basics",
  instructions: "Instructions",
  capture: "Capture fields",
  forms: "Forms",
  layout: "Layout",
  outputs: "Outputs & triggers",
};
const SMART = ["$today", "$now", "$tomorrow", "$nextSunday", "$serviceTime"] as const;

/** Workflow builder (W3): sections · editor · live preview; Save = new immutable version. */
export function WorkflowBuilder({ slug }: { slug?: string }) {
  const list = useQuery({
    queryKey: ["workflows"],
    queryFn: ({ signal }) => api.get<{ workflows: { id: string; slug: string }[] }>("/api/workflows", signal),
    enabled: !!slug,
  });
  const id = slug ? list.data?.workflows.find((w) => w.slug === slug)?.id : undefined;
  const detail = useQuery({ queryKey: ["workflow", id], queryFn: ({ signal }) => api.get<Detail>(`/api/workflows/${id}`, signal), enabled: !!id });
  if (slug && (list.isLoading || detail.isLoading)) return <Page width="wide">{<p className="text-sm text-muted">Loading…</p>}</Page>;
  if (slug && !id && !list.isLoading)
    return (
      <Page width="wide">
        <p className="text-sm text-danger">That workflow isn&apos;t here.</p>
      </Page>
    );
  return <BuilderView key={`${id ?? "new"}:${detail.data?.workflow.currentVersion ?? 0}`} detail={detail.data ?? null} />;
}

function BuilderView({ detail }: { detail: Detail | null }) {
  const router = useRouter();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [state, dispatch] = useReducer(builderReducer, undefined, () => initBuilder(detail?.definition, detail?.workflow.currentVersion ?? null));
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [serverIssues, setServerIssues] = useState<{ path: string; message: string }[]>([]);
  const issues = useMemo(() => issuesBySection(state.draft), [state.draft]);
  const issueCount = Object.values(issues).reduce((n, l) => n + l.length, 0);
  const d = state.draft;

  useEffect(() => {
    if (!state.dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [state.dirty]);

  const save = async () => {
    setSaving(true);
    setServerIssues([]);
    try {
      if (detail) {
        const r = await api.put<Detail>(`/api/workflows/${detail.workflow.id}`, { definition: d, changeNote: note || undefined });
        dispatch({ type: "saved", version: r.workflow.currentVersion });
        toast(`Saved v${r.workflow.currentVersion}`);
        await qc.invalidateQueries({ queryKey: ["workflow", detail.workflow.id] });
      } else {
        const r = await api.post<Detail>("/api/workflows", { definition: d, changeNote: note || undefined });
        toast("Saved as a draft (v1)");
        await qc.invalidateQueries({ queryKey: ["workflows"] });
        router.replace(`/workflows/${r.workflow.slug}/edit`);
      }
      setNote("");
    } catch (err) {
      const e = err as Error & { detail?: unknown };
      const detailIssues = Array.isArray(e.detail) ? (e.detail as { path: string; message: string }[]) : null;
      setServerIssues(detailIssues ?? [{ path: "", message: e.message }]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Page width="full">
      <PageHeader
        title={detail ? `Edit ${detail.workflow.name}` : "New workflow"}
        subtitle={
          detail ? `/${detail.workflow.slug} · v${state.baseVersion}${state.dirty ? " · unsaved changes" : ""}` : "Saved as a draft until you turn it on"
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => dispatch({ type: "undo" })} disabled={!state.past.length}>
              Undo
            </Button>
            <Button type="button" variant="primary" onClick={() => void save()} disabled={saving || issueCount > 0 || (!!detail && !state.dirty)}>
              {saving ? "Saving…" : detail ? "Save new version" : "Save draft"}
            </Button>
          </div>
        }
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[180px_minmax(0,1fr)_minmax(0,360px)]">
        <nav aria-label="Builder sections" className="flex min-w-0 flex-wrap gap-1 lg:flex-col">
          {BUILDER_SECTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className={`tap rounded-md px-3 py-2 text-left text-sm ${state.section === s ? "bg-surface-2 font-semibold" : ""}`}
              aria-current={state.section === s ? "step" : undefined}
              onClick={() => dispatch({ type: "section", section: s })}
            >
              {SECTION_LABEL[s]}
              {issues[s].length ? <span className="ml-1 text-danger">({issues[s].length})</span> : null}
            </button>
          ))}
        </nav>

        <section aria-label={SECTION_LABEL[state.section]} className="card min-w-0 p-4">
          <h2 className="mb-3 font-semibold">{SECTION_LABEL[state.section]}</h2>
          {issues[state.section].length ? (
            <ul role="alert" className="mb-3 space-y-1 text-sm text-danger" data-testid="builder-issues">
              {issues[state.section].map((i, n) => (
                <li key={n}>
                  {i.message}
                  {i.path ? <span className="text-muted"> ({i.path})</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {state.section === "basics" ? <Basics d={d} dispatch={dispatch} locked={!!detail} /> : null}
          {state.section === "instructions" ? (
            <Field id="wf-instructions" label="Instructions" hint={`${tokenCount(d.instructions)} tokens · ${d.instructions.length}/4000 characters`}>
              <textarea
                id="wf-instructions"
                className="input min-h-48 w-full"
                value={d.instructions}
                maxLength={4000}
                onChange={(e) => dispatch({ type: "instructions", text: e.target.value })}
              />
            </Field>
          ) : null}
          {state.section === "capture" ? <Capture d={d} dispatch={dispatch} /> : null}
          {state.section === "forms" ? <Forms d={d} slot={state.formSlot} selected={state.selectedField} dispatch={dispatch} /> : null}
          {state.section === "layout" ? (
            <p className="text-sm text-muted">
              Layouts use the Jarvis UI catalog only. The run panel uses the default outline for this workflow{d.layout ? " plus its custom layout" : ""}.
            </p>
          ) : null}
          {state.section === "outputs" ? <p className="text-sm text-muted">Summary, exports and schedules arrive in the next update.</p> : null}
          <div className="mt-4 flex min-w-0 flex-wrap items-end gap-2 border-t border-line pt-3">
            <Field id="wf-note" label="Change note (optional)">
              <input id="wf-note" className="input w-full" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </div>
          {serverIssues.length ? (
            <ul role="alert" className="mt-2 space-y-1 text-sm text-danger">
              {serverIssues.map((i, n) => (
                <li key={n}>{i.message}</li>
              ))}
            </ul>
          ) : null}
        </section>

        <div className="flex min-w-0 flex-col gap-4">
          <Preview d={d} mode={state.previewMode} onMode={(mode) => dispatch({ type: "preview", mode })} />
          {detail ? <History detail={detail} /> : null}
        </div>
      </div>
    </Page>
  );
}

type Dispatch = (a: Parameters<typeof builderReducer>[1]) => void;

function Basics({ d, dispatch, locked }: { d: WorkflowDefinition; dispatch: Dispatch; locked: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field id="wf-name" label="Name">
        <input
          id="wf-name"
          className="input w-full"
          value={d.name}
          maxLength={60}
          onChange={(e) => dispatch({ type: "basics", patch: { name: e.target.value } })}
        />
      </Field>
      <Field id="wf-slug" label="Command" hint={locked ? "The /command can't change after the first save" : "Lowercase letters, digits and dashes"}>
        <input
          id="wf-slug"
          className="input w-full"
          value={d.slug}
          readOnly={locked}
          maxLength={40}
          onChange={(e) => dispatch({ type: "basics", patch: { slug: e.target.value.toLowerCase() } })}
        />
      </Field>
      <Field id="wf-icon" label="Icon">
        <select
          id="wf-icon"
          className="input w-full"
          value={d.icon}
          onChange={(e) => dispatch({ type: "basics", patch: { icon: e.target.value as WorkflowDefinition["icon"] } })}
        >
          {WORKFLOW_ICONS.map((i) => (
            <option key={i}>{i}</option>
          ))}
        </select>
      </Field>
      <Field id="wf-area" label="Area" hint="Path like Faith or Home/Chores; Finance isn't allowed">
        <input
          id="wf-area"
          className="input w-full"
          value={d.routing.area ?? ""}
          onChange={(e) => dispatch({ type: "basics", patch: { area: e.target.value.trim() ? e.target.value : null } })}
        />
      </Field>
      <Field id="wf-tier" label="Model tier">
        <select
          id="wf-tier"
          className="input w-full"
          value={d.routing.modelTier}
          onChange={(e) => dispatch({ type: "basics", patch: { modelTier: e.target.value as WorkflowDefinition["routing"]["modelTier"] } })}
        >
          {MODEL_TIERS.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </Field>
      <Field id="wf-desc" label="Description">
        <input
          id="wf-desc"
          className="input w-full"
          value={d.description ?? ""}
          maxLength={280}
          onChange={(e) => dispatch({ type: "basics", patch: { description: e.target.value } })}
        />
      </Field>
    </div>
  );
}

function Capture({ d, dispatch }: { d: WorkflowDefinition; dispatch: Dispatch }) {
  const [key, setKey] = useState("");
  return (
    <div className="space-y-3">
      <ul className="space-y-1" aria-label="Capture fields">
        {Object.entries(d.capture).map(([k, v]) => (
          <li key={k} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-sm">
            <span className="min-w-0 break-words">
              <strong>{k}</strong> <span className="text-muted">{v.type === "list" ? "list" : `object · ${Object.keys(v.fields).join(", ")}`}</span>
            </span>
            <Button type="button" size="sm" onClick={() => dispatch({ type: "captureRemove", key: k })} aria-label={`Remove ${k}`}>
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <form
        className="flex min-w-0 flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!key) return;
          dispatch({ type: "captureAdd", key, spec: "list" });
          setKey("");
        }}
      >
        <Field id="wf-cap-key" label="New list (e.g. quotes)">
          <input id="wf-cap-key" className="input" value={key} pattern="[a-z][A-Za-z0-9_]{0,39}" onChange={(e) => setKey(e.target.value)} />
        </Field>
        <Button type="submit">Add list</Button>
      </form>
    </div>
  );
}

function Forms({ d, slot, selected, dispatch }: { d: WorkflowDefinition; slot: FormSlot; selected: string | null; dispatch: Dispatch }) {
  const fields = d.forms?.[slot]?.fields ?? [];
  const field = formFields(d, slot).find((f) => f.id === selected) ?? null;
  return (
    <div className="space-y-3">
      <div role="tablist" aria-label="Form" className="flex flex-wrap gap-1">
        {(["start", "mid", "end"] as const).map((s) => (
          <button
            key={s}
            role="tab"
            type="button"
            aria-selected={slot === s}
            className={`tap rounded-md px-3 py-1 text-sm ${slot === s ? "bg-surface-2 font-semibold" : ""}`}
            onClick={() => dispatch({ type: "formSlot", slot: s })}
          >
            {s === "start" ? "Start" : s === "mid" ? "Mid-run" : "End"}
          </button>
        ))}
      </div>
      <ol className="space-y-1" aria-label="Form fields">
        {fields.map((f) => {
          const fid = typeof f === "string" ? f : f.id;
          return (
            <li key={fid} className="flex min-w-0 flex-wrap items-center gap-1 rounded-md border border-line px-2 py-1 text-sm">
              <button
                type="button"
                className="tap min-w-0 flex-auto text-left break-words"
                aria-pressed={selected === fid}
                onClick={() => dispatch({ type: "fieldSelect", id: fid })}
              >
                {typeof f === "string" ? `↪ ${f}` : `${f.label} · ${f.type}`}
              </button>
              <Button type="button" size="sm" aria-label={`Move ${fid} up`} onClick={() => dispatch({ type: "fieldMove", slot, id: fid, delta: -1 })}>
                ↑
              </Button>
              <Button type="button" size="sm" aria-label={`Move ${fid} down`} onClick={() => dispatch({ type: "fieldMove", slot, id: fid, delta: 1 })}>
                ↓
              </Button>
              <Button type="button" size="sm" aria-label={`Remove ${fid}`} onClick={() => dispatch({ type: "fieldRemove", slot, id: fid })}>
                ✕
              </Button>
            </li>
          );
        })}
      </ol>
      <div aria-label="Add a field" role="group" className="flex flex-wrap gap-1">
        {FIELD_TYPES.map((t) => (
          <Button key={t} type="button" size="sm" onClick={() => dispatch({ type: "fieldAdd", slot, fieldType: t })}>
            + {t}
          </Button>
        ))}
      </div>
      {field ? <Inspector field={field} slot={slot} d={d} dispatch={dispatch} /> : null}
    </div>
  );
}

function Inspector({ field, slot, d, dispatch }: { field: WorkflowField; slot: FormSlot; d: WorkflowDefinition; dispatch: Dispatch }) {
  const src = sourceOfDefault(field.default);
  const setSrc = (s: DefaultSource) => dispatch({ type: "fieldDefault", slot, id: field.id, source: s });
  const args = d.start?.args ?? [];
  return (
    <fieldset className="space-y-2 rounded-md border border-line p-3" aria-label={`Settings for ${field.label}`}>
      <legend className="px-1 text-sm font-semibold">Field settings</legend>
      <Field id="wf-f-label" label="Label">
        <input
          id="wf-f-label"
          className="input w-full"
          value={field.label}
          maxLength={80}
          onChange={(e) => dispatch({ type: "fieldUpdate", slot, id: field.id, patch: { label: e.target.value } })}
        />
      </Field>
      <Field id="wf-f-help" label="Help text">
        <input
          id="wf-f-help"
          className="input w-full"
          value={field.help ?? ""}
          maxLength={200}
          onChange={(e) => dispatch({ type: "fieldUpdate", slot, id: field.id, patch: { help: e.target.value || undefined } })}
        />
      </Field>
      <Field id="wf-f-default" label="Default">
        <select
          id="wf-f-default"
          className="input w-full"
          value={src.kind === "smart" ? src.source : src.kind}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "none" || v === "last") setSrc({ kind: v });
            else if (v === "literal") setSrc({ kind: "literal", value: "" });
            else setSrc({ kind: "smart", source: v as (typeof SMART)[number] });
          }}
        >
          <option value="none">None</option>
          <option value="literal">Fixed value</option>
          <option value="last">Last used</option>
          {SMART.map((s) => (
            <option key={s} value={s}>
              Smart: {s.slice(1)}
            </option>
          ))}
        </select>
      </Field>
      {src.kind === "literal" ? (
        <Field id="wf-f-literal" label="Fixed value">
          <input
            id="wf-f-literal"
            className="input w-full"
            value={src.value}
            maxLength={200}
            onChange={(e) => setSrc({ kind: "literal", value: e.target.value })}
          />
        </Field>
      ) : null}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={!!field.required}
          onChange={(e) => dispatch({ type: "fieldUpdate", slot, id: field.id, patch: { required: e.target.checked || undefined } })}
        />
        Required
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={!!field.rememberLast}
          onChange={(e) => dispatch({ type: "fieldUpdate", slot, id: field.id, patch: { rememberLast: e.target.checked || undefined } })}
        />
        Remember last value
      </label>
      {slot === "start" ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={args.includes(field.id)}
            onChange={(e) => dispatch({ type: "argsSet", ids: e.target.checked ? [...args, field.id] : args.filter((a) => a !== field.id) })}
          />
          Fill from palette text (/{d.slug} …)
        </label>
      ) : null}
    </fieldset>
  );
}

function previewValue(f: WorkflowField): string {
  const s = sourceOfDefault(f.default);
  if (s.kind === "literal") return s.value;
  if (s.kind === "smart") return `(${s.source.slice(1)})`;
  if (s.kind === "last") return "(last used)";
  return "";
}

function Preview({ d, mode, onMode }: { d: WorkflowDefinition; mode: "defaults" | "empty" | "errors"; onMode: (m: "defaults" | "empty" | "errors") => void }) {
  const fields = formFields(d, "start");
  return (
    <section aria-label="Preview" className="card min-w-0 p-3" data-testid="builder-preview">
      <div className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Preview</h2>
        <div role="radiogroup" aria-label="Preview state" className="flex flex-wrap gap-1">
          {(["defaults", "empty", "errors"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              className={`tap rounded-md px-2 text-sm ${mode === m ? "bg-surface-2 font-semibold" : ""}`}
              onClick={() => onMode(m)}
            >
              {m === "defaults" ? "Defaults" : m === "empty" ? "Empty" : "Errors"}
            </button>
          ))}
        </div>
      </div>
      <p className="mb-2 text-sm font-semibold break-words">{d.forms?.start?.title ?? d.name}</p>
      {fields.length === 0 ? <p className="text-sm text-muted">No start form: the run opens straight into the chat.</p> : null}
      <ul className="space-y-2">
        {fields.map((f) => {
          const err = mode === "errors" && f.required ? `${f.label} is required` : null;
          return (
            <li key={f.id} className="min-w-0 text-sm">
              <span className="block font-medium break-words">
                {f.label}
                {f.required ? " *" : ""}
              </span>
              <span className={`block min-h-9 rounded-md border px-2 py-1 break-words ${err ? "border-danger" : "border-line"}`}>
                {mode === "defaults" ? previewValue(f) : ""}
              </span>
              {err ? <span className="block text-danger">{err}</span> : f.help ? <span className="block text-muted">{f.help}</span> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function History({ detail }: { detail: Detail }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState<number | null>(null);
  const diff = useQuery({
    queryKey: ["workflow-version", detail.workflow.id, open],
    queryFn: ({ signal }) => api.get<{ changes: DiffChange[]; summary: string }>(`/api/workflows/${detail.workflow.id}/versions/${open}`, signal),
    enabled: open != null,
  });
  const restore = async (v: number) => {
    try {
      const r = await api.post<Detail>(`/api/workflows/${detail.workflow.id}/versions/${v}/restore`);
      toast(`Restored v${v} as v${r.workflow.currentVersion}`);
      await qc.invalidateQueries({ queryKey: ["workflow", detail.workflow.id] });
    } catch (err) {
      toast((err as Error).message, "danger");
    }
  };
  return (
    <section aria-label="Version history" className="card min-w-0 p-3">
      <h2 className="mb-2 font-semibold">Versions</h2>
      <ol className="space-y-1 text-sm">
        {detail.versions.map((v) => (
          <li key={v.version} className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="font-medium">v{v.version}</span>
              <span className="min-w-0 flex-auto break-words text-muted">{v.changeNote ?? ""}</span>
              <Button type="button" size="sm" aria-expanded={open === v.version} onClick={() => setOpen(open === v.version ? null : v.version)}>
                Changes
              </Button>
              {v.version !== detail.workflow.currentVersion ? (
                <Button type="button" size="sm" onClick={() => void restore(v.version)} aria-label={`Restore v${v.version}`}>
                  Restore
                </Button>
              ) : null}
            </div>
            {open === v.version && diff.data ? (
              <div className="mt-1 rounded-md border border-line p-2" data-testid="version-diff">
                <p>{diff.data.summary}</p>
                <ul className="mt-1 space-y-0.5">
                  {diff.data.changes.slice(0, 20).map((c, i) => (
                    <li key={i} className="break-words">
                      <span className="text-muted">{c.kind}</span> {c.path || "definition"}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
