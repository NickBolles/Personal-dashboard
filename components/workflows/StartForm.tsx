"use client";

import { useId, useMemo, useState, type ReactNode } from "react";
import { Button, Dialog, Input, Textarea } from "@/components/ui";
import type { RunElement } from "@/lib/workflows/run-catalog";
import { formatDistance, matchSavedPlace, type FormValue, type SavedPlace } from "@/lib/workflows/runs";
import { parseScriptureRef } from "@/lib/workflows/scripture";
import { PassageText } from "./PassageText";

export type StartFormData = {
  workflow: { id: string; slug: string; name: string };
  spec: RunElement | null;
  values: Record<string, FormValue>;
  form: { fields: { id: string; quickDates?: { id: string; label: string; value: string }[]; recent?: unknown[] }[] };
  places: (SavedPlace & { addressText: string | null })[];
  people: string[];
  stripLocation: boolean;
  /** palette text no field matched; kept in the first message (#124) */
  unmatched?: string;
};

type Values = Record<string, unknown>;
type FieldProps = { el: RunElement; value: unknown; set: (v: unknown) => void; error?: string; note?: string; data: StartFormData };

function show(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  const o = v as Record<string, unknown>;
  return String(o.display ?? o.label ?? o.name ?? "");
}

/** Shared field chrome: visible label, help/provenance/error via aria-describedby (§12.11 a11y). */
function Shell({
  id,
  label,
  required,
  help,
  note,
  error,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  help?: string;
  note?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
        {required ? <span className="sr-only"> (required)</span> : null}
      </label>
      {children}
      {note ? (
        <p id={`${id}-note`} className="text-xs text-muted" data-dynamic>
          {note}
        </p>
      ) : null}
      {help ? (
        <p id={`${id}-help`} className="text-xs text-muted">
          {help}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-err`} className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function describedBy(id: string, p: { help?: unknown; note?: string; error?: string }) {
  return [p.note && `${id}-note`, p.help && `${id}-help`, p.error && `${id}-err`].filter(Boolean).join(" ") || undefined;
}

function TextLike({ el, value, set, error, note, multiline, list }: FieldProps & { multiline?: boolean; list?: string }) {
  const id = `wf-${el.props.id as string}`;
  const p = el.props as { label: string; required?: boolean; help?: string; maxLength?: number; placeholder?: string };
  const common = {
    id,
    value: show(value),
    onChange: (e: { target: { value: string } }) => set(e.target.value),
    "aria-invalid": error ? true : undefined,
    "aria-required": p.required || undefined,
    "aria-describedby": describedBy(id, { help: p.help, note, error }),
    maxLength: p.maxLength,
    placeholder: p.placeholder,
    className: "w-full min-w-0",
  };
  return (
    <Shell {...{ id, label: p.label, required: p.required, help: p.help, note, error }}>
      {multiline ? <Textarea rows={3} {...common} /> : <Input type="text" list={list} {...common} />}
    </Shell>
  );
}

function ScriptureField(props: FieldProps) {
  const parsed = typeof props.value === "string" && props.value.trim() ? parseScriptureRef(props.value) : null;
  return (
    <div className="min-w-0">
      <TextLike {...props} value={props.value} />
      <p className="text-xs text-muted" aria-live="polite">
        {parsed
          ? parsed.ok
            ? parsed.ref.display
            : "ambiguous" in parsed
              ? `Did you mean ${(parsed as { ambiguous: string[] }).ambiguous.join(", ")}?`
              : ""
          : ""}
      </p>
      {/* prefilled values are parsed refs ({display}); typed ones are strings */}
      {parsed?.ok ? (
        <PassageText reference={parsed.ref.display} compact />
      ) : !parsed && show(props.value) ? (
        <PassageText reference={show(props.value)} compact />
      ) : null}
    </div>
  );
}

function DateTimeField({ el, value, set, error, note, data }: FieldProps) {
  const id = `wf-${el.props.id as string}`;
  const p = el.props as { label: string; required?: boolean; help?: string; mode: "date" | "time" | "datetime" };
  const quick = data.form.fields.find((f) => f.id === el.props.id)?.quickDates ?? [];
  return (
    <Shell {...{ id, label: p.label, required: p.required, help: p.help, note, error }}>
      <Input
        id={id}
        type={p.mode === "datetime" ? "datetime-local" : p.mode}
        value={show(value)}
        onChange={(e) => set(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, { help: p.help, note, error })}
        className="w-full min-w-0"
      />
      {quick.length ? (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={`${p.label} shortcuts`}>
          {quick.map((q) => (
            <Button
              type="button"
              key={q.id}
              size="sm"
              variant="ghost"
              className="max-w-full whitespace-normal"
              aria-pressed={value === q.value}
              onClick={() => set(q.value)}
            >
              {q.label}
            </Button>
          ))}
        </div>
      ) : null}
    </Shell>
  );
}

/**
 * Place (§12.7, D9): default / saved / recent / typed. "Use my location" asks
 * the browser only on tap and compares on this device with SAVED places; the
 * position is discarded right away — never sent anywhere. Hidden when
 * location stripping is on. No reverse geocoding.
 */
function PlaceField({ el, value, set, error, note, data }: FieldProps) {
  const id = `wf-${el.props.id as string}`;
  const p = el.props as { label: string; required?: boolean; help?: string; geolocate: "off" | "matchSaved" };
  const [status, setStatus] = useState("");
  const recent = (data.form.fields.find((f) => f.id === el.props.id)?.recent ?? []).map(show).filter(Boolean);
  const options = [...new Set([...data.places.map((x) => x.label), ...recent])].slice(0, 12);
  const listId = `${id}-list`;
  const locate = () => {
    if (!("geolocation" in navigator)) return setStatus("Location isn't available on this device");
    setStatus("Checking your saved places…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const m = matchSavedPlace({ lat: pos.coords.latitude, lng: pos.coords.longitude }, data.places);
        if (m) {
          set({ placeId: m.place.id, label: m.place.label, kind: "saved" });
          setStatus(`You're at ${m.place.label} · ${formatDistance(m.distanceM)}`);
        } else setStatus("No saved place nearby");
      },
      () => setStatus("Couldn't get your location"),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    );
  };
  return (
    <Shell {...{ id, label: p.label, required: p.required, help: p.help, note, error }}>
      <Input
        id={id}
        type="text"
        list={listId}
        value={show(value)}
        onChange={(e) => {
          const label = e.target.value;
          const saved = data.places.find((x) => x.label === label);
          set(label ? (saved ? { placeId: saved.id, label, kind: "saved" } : { label, kind: recent.includes(label) ? "recent" : "typed" }) : null);
        }}
        aria-invalid={error ? true : undefined}
        aria-describedby={[describedBy(id, { help: p.help, note, error }), status ? `${id}-geo` : ""].filter(Boolean).join(" ") || undefined}
        className="w-full min-w-0"
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
      {p.geolocate === "matchSaved" && !data.stripLocation && data.places.some((x) => x.lat !== null) ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={locate} aria-describedby={`${id}-geohelp`}>
            Use my location
          </Button>
          <span id={`${id}-geohelp`} className="sr-only">
            Checks your saved places on this device. Your location is not sent or stored.
          </span>
          <span id={`${id}-geo`} className="text-xs text-muted" aria-live="polite" data-testid="place-geo-status">
            {status}
          </span>
        </div>
      ) : null}
    </Shell>
  );
}

function PersonField(props: FieldProps) {
  const id = `wf-${props.el.props.id as string}`;
  const recent = (props.data.form.fields.find((f) => f.id === props.el.props.id)?.recent ?? []).map(show).filter(Boolean);
  const names = [...new Set([...recent, ...props.data.people])].slice(0, 20);
  return (
    <div className="min-w-0">
      <TextLike {...props} list={`${id}-people`} />
      <datalist id={`${id}-people`}>
        {names.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
    </div>
  );
}

function ChoiceField({ el, value, set, error, note }: FieldProps) {
  const id = `wf-${el.props.id as string}`;
  const p = el.props as { label: string; required?: boolean; help?: string; options: { value: string; label: string }[] };
  return (
    <div className="min-w-0">
      <Shell {...{ id, label: p.label, required: p.required, help: p.help, note, error }}>
        <Input
          id={id}
          type="text"
          list={`${id}-opts`}
          value={show(value)}
          onChange={(e) => set(e.target.value)}
          aria-describedby={describedBy(id, { help: p.help, note, error })}
          className="w-full min-w-0"
        />
        <datalist id={`${id}-opts`}>
          {p.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </datalist>
      </Shell>
    </div>
  );
}

function TagsField({ el, value, set, error, note }: FieldProps) {
  const id = `wf-${el.props.id as string}`;
  const p = el.props as { label: string; help?: string; max?: number };
  const tags = Array.isArray(value) ? (value as string[]) : [];
  const [draft, setDraft] = useState("");
  const add = () => {
    const t = draft.trim().replace(/,$/, "");
    if (t && !tags.includes(t) && tags.length < (p.max ?? 8)) set([...tags, t]);
    setDraft("");
  };
  return (
    <Shell {...{ id, label: p.label, help: p.help, note, error }}>
      {tags.length ? (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((t) => (
            <Button
              type="button"
              key={t}
              size="sm"
              variant="ghost"
              className="max-w-full whitespace-normal break-all"
              aria-label={`Remove tag ${t}`}
              onClick={() => set(tags.filter((x) => x !== t))}
            >
              {t} ×
            </Button>
          ))}
        </div>
      ) : null}
      <Input
        id={id}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
        className="w-full min-w-0"
      />
    </Shell>
  );
}

function NumberField({ el, value, set, error, note }: FieldProps) {
  const id = `wf-${el.props.id as string}`;
  const p = el.props as { label: string; help?: string; min?: number; max?: number; step?: number };
  return (
    <Shell {...{ id, label: p.label, help: p.help, note, error }}>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min={p.min}
        max={p.max}
        step={p.step}
        value={value === null || value === undefined ? "" : String(value)}
        onChange={(e) => set(e.target.value === "" ? null : Number(e.target.value))}
        className="w-full min-w-0"
      />
    </Shell>
  );
}

function ToggleField({ el, value, set }: FieldProps) {
  const id = `wf-${el.props.id as string}`;
  return (
    <div className="flex min-h-11 items-center justify-between gap-3">
      <label htmlFor={id} className="text-sm font-medium">
        {el.props.label as string}
      </label>
      <Button id={id} type="button" role="switch" aria-checked={value === true} onClick={() => set(!value)} className="shrink-0 whitespace-normal">
        {value ? "On" : "Off"}
      </Button>
    </div>
  );
}

/** Closed registry: only catalog `jarvis-ui@1.1` form parts render. Unknown elements are dropped. */
const FIELDS: Partial<Record<RunElement["type"], (p: FieldProps) => ReactNode>> = {
  TextField: (p) => <TextLike {...p} />,
  LongTextField: (p) => <TextLike {...p} multiline />,
  ChoiceField: ChoiceField,
  DateTimeField: DateTimeField,
  PlaceField: PlaceField,
  PersonField: PersonField,
  ScriptureField: ScriptureField,
  TagsField: TagsField,
  NumberField: NumberField,
  ToggleField: ToggleField,
};

/**
 * Start form (D7): always shown, prefilled with smart defaults, one tap Start.
 * Errors come back from the server too (server wins); focus moves to the first.
 */
export function StartFormDialog({
  data,
  onClose,
  onSubmit,
}: {
  data: StartFormData;
  onClose: () => void;
  onSubmit: (values: Values) => Promise<{ errors?: { field: string; message: string }[] } | void>;
}) {
  const formId = useId();
  const init = useMemo(() => Object.fromEntries(Object.entries(data.values).map(([k, v]) => [k, v.value])), [data.values]);
  const [values, setValues] = useState<Values>(init);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  // Definitions may omit forms.start: still show a one-tap Start confirmation.
  const spec: RunElement = data.spec ?? { type: "Form", props: { title: `Start ${data.workflow.name}`, submit: "Start" }, children: [] };
  const submit = async () => {
    setBusy(true);
    const r = await onSubmit(values);
    setBusy(false);
    if (r && r.errors?.length) {
      setErrors(Object.fromEntries(r.errors.map((e) => [e.field, e.message])));
      document.getElementById(`wf-${r.errors[0].field}`)?.focus();
    }
  };
  const errList = Object.entries(errors);
  return (
    <Dialog
      open
      onClose={onClose}
      title={spec.props.title as string}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={busy} className="min-w-0 whitespace-normal" data-testid="workflow-start-submit">
            {spec.props.submit as string}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        className="space-y-4"
        aria-label={spec.props.title as string}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {errList.length ? (
          <div role="alert" className="text-sm text-danger">
            {errList.length === 1 ? errList[0][1] : `${errList.length} fields need a look`}
          </div>
        ) : null}
        {(spec.children ?? []).map((el) => {
          const F = FIELDS[el.type];
          const fid = el.props.id as string;
          if (!F) return null;
          const note = data.values[fid]?.note;
          return (
            <F
              key={fid}
              el={el}
              value={values[fid]}
              note={note}
              error={errors[fid]}
              data={data}
              set={(v) => {
                setValues((old) => ({ ...old, [fid]: v }));
                if (errors[fid]) setErrors(({ [fid]: _, ...rest }) => rest);
              }}
            />
          );
        })}
      </form>
    </Dialog>
  );
}
