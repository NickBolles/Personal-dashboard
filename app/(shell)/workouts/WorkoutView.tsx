"use client";

import { useEffect, useRef, useState } from "react";
import { useAccess } from "@/components/access";
import { api, ApiError, newIdempotencyKey } from "@/lib/client/api";
import {
  EQUIPMENT,
  FOCUSES,
  generatePlan,
  importSchema,
  sessionSchema,
  type Exercise,
  type PlanOptions,
  type WorkoutImport,
  type WorkoutRow,
  type WorkoutSession,
  type WorkoutSet,
} from "@/lib/workouts";

const button = "tap rounded-xl px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50";
const primary = `${button} bg-accent text-accent-contrast`;
const secondary = `${button} bg-surface-2`;
const field = "min-w-0 w-full rounded-xl bg-surface-2 px-3 py-3 tabular-nums";
type Save = { id: string; version: number; requestId: string; session: WorkoutSession };
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function WorkoutView() {
  const { can } = useAccess();
  const [rows, setRows] = useState<WorkoutRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<"train" | "history">("train");
  const [options, setOptions] = useState<PlanOptions>({
    focuses: ["legs", "push"],
    minutes: 35,
    equipment: ["machine", "bodyweight"],
    unit: "lb",
    neckFriendly: true,
  });
  const [draft, setDraft] = useState<WorkoutRow | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Save | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [importData, setImportData] = useState<WorkoutImport | null>(null);
  const saving = useRef(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let live = true;
    api
      .get<{ workouts: WorkoutRow[] }>("/api/workouts")
      .then(({ workouts }) => {
        if (!live) return;
        setRows(workouts);
        setDraft(workouts.find((r) => r.session.status === "active") ?? null);
        setLoaded(true);
      })
      .catch((e: Error) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!dirty && !pending) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, pending]);

  const history = rows.filter((r) => r.session.status === "completed");
  const plan =
    options.focuses.length && options.equipment.length
      ? generatePlan(
          options,
          history.map((r) => r.session),
        )
      : [];
  const locked = busy || !!pending;

  async function save(payload: Save) {
    if (saving.current) return;
    const valid = sessionSchema.safeParse(payload.session);
    if (!valid.success) {
      setError(valid.error.issues[0].message);
      return;
    }
    saving.current = true;
    setBusy(true);
    setError("");
    setPending(payload);
    try {
      const saved = await api.post<WorkoutRow>("/api/workouts", payload);
      // Read back the exact target before saying saved. Retry reuses the identical request.
      const result = await api.get<{ workouts: WorkoutRow[] }>("/api/workouts");
      const confirmed = result.workouts.find((r) => r.id === saved.id);
      if (!confirmed || confirmed.version < saved.version) throw new Error("Save could not be verified. Retry safely.");
      setRows(result.workouts);
      setDraft(confirmed.session.status === "active" ? confirmed : null);
      setDirty(false);
      setPending(null);
      setNotice(confirmed.session.status === "completed" ? "Workout finished · saved privately in Jarvis" : "Saved in Jarvis · ready to resume");
    } catch (e) {
      setError((e as Error).message);
      // Validation/conflicts cannot be retried unchanged. Keep edits, offer reload explicitly.
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) setPending(null);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  function persist(session: WorkoutSession, existing = draft) {
    void save({ id: existing?.id ?? newIdempotencyKey("workout"), version: existing?.version ?? 0, requestId: newIdempotencyKey("set"), session });
  }
  function changeSet(ei: number, si: number, patch: Partial<WorkoutSet>, complete = false) {
    if (!draft || locked) return;
    const session = structuredClone(draft.session);
    Object.assign(session.exercises[ei].sets[si], patch);
    setDraft({ ...draft, session });
    setDirty(true);
    setNotice("");
    setError("");
    if (complete) persist(session);
  }
  async function readImport(file?: File) {
    if (!file) return;
    setError("");
    setImportData(null);
    try {
      if (file.size > 250_000) throw new Error("Choose a JSON file smaller than 250 KB.");
      setImportData(importSchema.parse(JSON.parse(await file.text())));
    } catch {
      setError("Invalid workout JSON. Check schemaVersion 1, profile, dates and workout/set values (250 KB maximum).");
    }
  }
  async function confirmImport() {
    if (!importData || saving.current) return;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api.post<{ imported: number; skipped: number }>("/api/workouts/import", importData);
      const readback = await api.get<{ workouts: WorkoutRow[] }>("/api/workouts");
      if (!importData.workouts.every((w) => readback.workouts.some((r) => r.source?.workout.id === w.id)))
        throw new Error("Import readback incomplete. Retry the same file safely.");
      setRows(readback.workouts);
      setImportData(null);
      setNotice(`${result.imported} imported · ${result.skipped} already present · saved in Jarvis`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  if (!can("workouts.use")) return <p>You do not have access to workouts.</p>;
  return (
    <div className="mx-auto max-w-3xl space-y-7 px-4 py-6 sm:px-6">
      <header className="flex items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Your training, simplified</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Workouts</h1>
        </div>
        <span className="rounded-full bg-accent-soft px-3 py-1 text-xs font-medium text-accent">Private</span>
      </header>
      <nav aria-label="Workout views" className="flex gap-2 rounded-2xl bg-surface p-1">
        {(["train", "history"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            aria-pressed={tab === t}
            className={`${button} flex-1 ${tab === t ? "bg-accent-soft text-accent" : "text-muted"}`}
          >
            {t === "train" ? "Train" : `History · ${history.length}`}
          </button>
        ))}
      </nav>
      <div aria-live="polite">
        {notice && <p className="text-sm text-ok">{notice}</p>}
        {error && (
          <div role="alert" className="space-y-2 rounded-xl bg-danger-soft p-3 text-sm text-danger">
            <p>{error}</p>
            {pending && (
              <button className={secondary} disabled={busy} onClick={() => void save(pending)}>
                Retry save
              </button>
            )}
            <button
              className={`${button} underline`}
              disabled={busy}
              onClick={() => {
                if ((!dirty && !pending) || window.confirm("Reload server state? Unsaved edits will be lost.")) window.location.reload();
              }}
            >
              Reload saved state
            </button>
          </div>
        )}
      </div>
      {!loaded ? (
        <p className="text-muted">Loading your private workouts…</p>
      ) : tab === "train" ? (
        <>
          {draft ? (
            <section aria-label="Active workout" className="space-y-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-accent">In progress</p>
                  <h2 className="mt-1 text-xl font-semibold">{draft.session.title}</h2>
                  <p className="text-sm text-muted">
                    {draft.session.date} · {draft.session.exercises.flatMap((e) => e.sets).filter((s) => s.done).length} sets done
                  </p>
                </div>
                <span className="text-xs text-muted">{busy ? "Saving…" : dirty ? "Unsaved edits" : "Saved"}</span>
              </div>
              <p className="text-xs text-muted">
                Tap Done to save a set. Edit a completed set, then Save edits. Use the same machine and load convention each time.
              </p>
              <fieldset disabled={locked} className="min-w-0 space-y-4">
                {draft.session.exercises.map((e, ei) => (
                  <article key={ei} className="space-y-4 rounded-2xl bg-surface p-4 sm:p-5">
                    <div>
                      <span className="text-xs font-medium uppercase tracking-wider text-muted">
                        {String(ei + 1).padStart(2, "0")} / {e.equipment}
                      </span>
                      <h3 className="mt-1 text-lg font-semibold tracking-tight">{e.name}</h3>
                      <RecordHint exercise={e} />
                    </div>
                    <div className="grid grid-cols-[1.5rem_1fr_1fr_4rem] gap-2 text-xs text-muted" aria-hidden="true">
                      <span>Set</span>
                      <span>{e.equipment === "bodyweight" ? "Load" : e.unit}</span>
                      <span>Reps</span>
                      <span>Save</span>
                    </div>
                    {e.sets.map((s, si) => (
                      <div key={si} className="grid grid-cols-[1.5rem_1fr_1fr_4rem] items-center gap-2">
                        <span className="text-sm tabular-nums text-muted">{si + 1}</span>
                        {e.equipment === "bodyweight" ? (
                          <span className="text-xs text-muted">Bodyweight</span>
                        ) : (
                          <input
                            aria-label={`${e.name} set ${si + 1} weight`}
                            className={field}
                            type="number"
                            inputMode="decimal"
                            min="0"
                            max="2000"
                            step="0.5"
                            placeholder="Load"
                            value={s.weight ?? ""}
                            onChange={(ev) => changeSet(ei, si, { weight: ev.target.value === "" ? undefined : Number(ev.target.value) })}
                          />
                        )}
                        <input
                          aria-label={`${e.name} set ${si + 1} reps`}
                          className={field}
                          type="number"
                          inputMode="numeric"
                          min="1"
                          max="1000"
                          value={s.reps ?? ""}
                          onChange={(ev) => changeSet(ei, si, { reps: ev.target.value === "" ? undefined : Number(ev.target.value) })}
                        />
                        <button
                          aria-label={`${s.done ? "Undo" : "Complete"} ${e.name} set ${si + 1}`}
                          aria-pressed={s.done}
                          className={`${button} px-2 ${s.done ? "bg-ok-soft text-ok" : "bg-accent-soft text-accent"}`}
                          onClick={() => changeSet(ei, si, { done: !s.done }, true)}
                        >
                          {s.done ? "✓" : "Done"}
                        </button>
                      </div>
                    ))}
                  </article>
                ))}
                <label className="block text-sm">
                  Session notes
                  <textarea
                    className={`${field} mt-2`}
                    maxLength={8000}
                    value={draft.session.notes}
                    placeholder="How did it feel? Anything to change next time?"
                    onChange={(e) => {
                      setDraft({ ...draft, session: { ...draft.session, notes: e.target.value } });
                      setDirty(true);
                      setNotice("");
                    }}
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <button className={secondary} onClick={() => persist(draft.session)}>
                    Save edits
                  </button>
                  <button className={`${primary} flex-1`} onClick={() => persist({ ...draft.session, status: "completed" })}>
                    Finish workout
                  </button>
                </div>
              </fieldset>
            </section>
          ) : (
            <section className="space-y-6" aria-label="Build a workout">
              <div>
                <h2 className="text-xl font-semibold tracking-tight">What are we working on?</h2>
                <p className="mt-1 text-sm text-muted">A few choices. A ready-to-go plan.</p>
              </div>
              <fieldset disabled={locked} className="min-w-0 space-y-5">
                <ChipGroup
                  label="Focus"
                  values={FOCUSES}
                  selected={options.focuses}
                  onChange={(v) => setOptions({ ...options, focuses: toggle(options.focuses, v) })}
                />
                <ChipGroup
                  label="Time budget"
                  values={[20, 35, 50] as const}
                  selected={[options.minutes]}
                  onChange={(v) => setOptions({ ...options, minutes: v })}
                  suffix=" min"
                />
                <ChipGroup
                  label="Equipment available"
                  values={EQUIPMENT}
                  selected={options.equipment}
                  onChange={(v) => setOptions({ ...options, equipment: toggle(options.equipment, v) })}
                />
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <label className="flex min-h-11 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="h-5 w-5 accent-accent"
                      checked={options.neckFriendly}
                      onChange={(e) => setOptions({ ...options, neckFriendly: e.target.checked })}
                    />
                    Neck-friendly selection
                  </label>
                  <label className="text-sm">
                    Load unit{" "}
                    <select
                      className="tap rounded-lg bg-surface-2 px-3"
                      value={options.unit}
                      onChange={(e) => setOptions({ ...options, unit: e.target.value as "lb" | "kg" })}
                    >
                      <option value="lb">lb</option>
                      <option value="kg">kg</option>
                    </select>
                  </label>
                </div>
                <div className="space-y-4 rounded-2xl bg-surface p-4 sm:p-5">
                  <div className="flex justify-between gap-2">
                    <h3 className="font-semibold">Your plan</h3>
                    <span className="text-xs text-muted">
                      {plan.length} exercises · ~{options.minutes} min
                    </span>
                  </div>
                  <p className="text-xs text-muted">
                    Deterministic plan from your completed Jarvis sets, not AI. Includes time for warm-up and rests; adjust to your pace.
                  </p>
                  {plan.map((e) => (
                    <div key={e.name} className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{e.name}</p>
                        <RecordHint exercise={e} />
                      </div>
                      <span className="shrink-0 rounded-lg bg-surface-2 px-2 py-1 text-xs tabular-nums">{e.sets.length} × 8</span>
                    </div>
                  ))}
                  {!plan.length && <p className="text-sm text-muted">Select a focus and matching equipment. Core uses bodyweight.</p>}
                  <button
                    className={`${primary} w-full`}
                    disabled={!plan.length}
                    onClick={() =>
                      persist(
                        {
                          date: today(),
                          title: `${options.focuses.map((f) => f[0].toUpperCase() + f.slice(1)).join(" + ")} · ${options.minutes} min`,
                          status: "active",
                          notes: "",
                          exercises: plan,
                        },
                        null,
                      )
                    }
                  >
                    Start workout
                  </button>
                </div>
              </fieldset>
            </section>
          )}
          <p className="text-xs leading-relaxed text-muted">
            Form before records. Neck-friendly is a filter, not a medical guarantee. Keep your neck comfortable; stop or modify any movement that causes pain.
            Targets are optional, never a reason to force a rep.
          </p>
        </>
      ) : (
        <section className="space-y-5" aria-label="Workout history">
          <div>
            <h2 className="text-xl font-semibold">Your training history</h2>
            <p className="mt-1 text-sm text-muted">Completed sessions, exactly as recorded.</p>
          </div>
          <input
            aria-label="Search workout history"
            className={field}
            placeholder="Search sessions or exercises"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {!history.length && (
            <p className="rounded-2xl bg-surface p-5 text-sm text-muted">
              Your first session starts here. Train now or bring in your previous workout JSON below.
            </p>
          )}
          {history
            .filter((r) =>
              `${r.session.title} ${r.session.date} ${r.session.exercises.map((e) => e.name).join(" ")}`.toLowerCase().includes(search.toLowerCase()),
            )
            .map((r) => (
              <details key={r.id} className="rounded-2xl bg-surface p-4">
                <summary className="tap cursor-pointer">
                  <span className="text-xs text-muted">
                    {r.session.date}
                    {r.source ? " · Imported" : " · Jarvis"}
                  </span>
                  <span className="block font-medium">{r.session.title}</span>
                </summary>
                <div className="mt-3 space-y-4 text-sm">
                  {r.session.notes && <p className="whitespace-pre-wrap text-muted">{r.session.notes}</p>}
                  {r.source && (
                    <p className="rounded-lg bg-warn-soft p-3 text-xs text-warn">
                      Original artifact preserved. Equipment and load convention are unverified; imported sets do not establish comparable PRs. Legacy aliases
                      are not merged.
                    </p>
                  )}
                  {r.session.exercises.map((e, i) => (
                    <div key={i}>
                      <h3 className="font-medium">{e.name}</h3>
                      <p className="text-xs text-muted">
                        {e.equipment} · {e.unit}
                      </p>
                      <ul className="mt-1 space-y-1 text-muted">
                        {e.sets.map((s, j) => (
                          <li key={j}>
                            {s.done ? "✓ " : "Not completed · "}
                            {s.weight !== undefined ? `${s.weight} ${e.unit} · ` : ""}
                            {s.reps !== undefined ? `${s.reps} reps` : ""}
                            {s.seconds !== undefined ? ` ${s.seconds} sec` : ""}
                            {s.side ? ` · ${s.side}` : ""}
                            {s.note ? ` · ${s.note}` : ""}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                  {r.source && (
                    <details>
                      <summary className="tap cursor-pointer text-xs">Source provenance</summary>
                      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(r.source, null, 2)}</pre>
                    </details>
                  )}
                </div>
              </details>
            ))}
          <details className="rounded-2xl bg-surface-2 p-4">
            <summary className="tap cursor-pointer font-medium">Import workout JSON</summary>
            <div className="space-y-3 pt-2">
              <p className="text-sm text-muted">
                Import into your account only. Preview first; existing source IDs are never overwritten. This does not change the original file.
              </p>
              <input
                aria-label="Workout JSON file"
                className="max-w-full text-sm"
                type="file"
                accept="application/json,.json"
                disabled={busy || !!pending}
                onChange={(e) => void readImport(e.target.files?.[0])}
              />
              {importData && (
                <div className="space-y-3">
                  <p className="text-sm">
                    {importData.workouts.length} sessions · {importData.profile.displayName} · {importData.profile.units}
                  </p>
                  <p className="text-xs text-muted">Equipment is unknown in legacy imports. We preserve every source value without inferring PRs.</p>
                  <button className={primary} disabled={busy} onClick={() => void confirmImport()}>
                    Confirm import
                  </button>
                </div>
              )}
            </div>
          </details>
        </section>
      )}
      <footer className="text-xs leading-relaxed text-muted">
        Saved privately in Jarvis. Notion sync is not implemented. Nothing is written to Notion or your original workout artifact.
      </footer>
    </div>
  );
}
function toggle<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}
function ChipGroup<T extends string | number>({
  label,
  values,
  selected,
  onChange,
  suffix = "",
}: {
  label: string;
  values: readonly T[];
  selected: readonly T[];
  onChange: (v: T) => void;
  suffix?: string;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {values.map((v) => (
          <button
            type="button"
            key={v}
            aria-pressed={selected.includes(v)}
            className={`${button} capitalize ${selected.includes(v) ? "bg-accent-soft text-accent" : "bg-surface text-muted"}`}
            onClick={() => onChange(v)}
          >
            {v}
            {suffix}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
function RecordHint({ exercise: e }: { exercise: Exercise }) {
  return (
    <div className="mt-1 space-y-1 text-xs leading-relaxed text-muted">
      <p>
        {e.sets[0]?.weight !== undefined
          ? `First set: ${e.sets[0].weight} ${e.unit} × ${e.sets[0].reps ?? "—"}`
          : e.equipment === "bodyweight"
            ? "Bodyweight · begin with 8 comfortable reps"
            : "No comparable history · enter a comfortable load"}
      </p>
      {e.best && (
        <>
          <p>
            Highest load: {e.best.highest.weight} {e.unit} × {e.best.highest.reps} · {e.best.highest.date}
          </p>
          {e.best.atLoad && (
            <p>
              Best at {e.best.atLoad.weight} {e.unit}: {e.best.atLoad.reps} reps · {e.best.atLoad.date}
            </p>
          )}
          {e.target && (
            <p className="text-accent">
              Optional: {e.target.reps} reps at {e.target.weight} {e.unit}, only with comfortable form.
            </p>
          )}
        </>
      )}
    </div>
  );
}
