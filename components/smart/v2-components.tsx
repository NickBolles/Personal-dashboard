"use client";
import Link from "next/link";
import { useContext, useId, useState, type ReactNode } from "react";
import type { ComponentRenderProps } from "@json-render/react";
import type { ComponentName, PropsOf } from "@/lib/jarvis-ui/catalog";
import { formIntents, ganttLayout, matrixIntent, matrixTotals, type FormValues } from "@/lib/jarvis-ui/v2";
import { intentKey, intentTarget } from "@/lib/jarvis-ui/intents";
import { smartLabel } from "@/lib/jarvis-ui/labels";
import { isTask } from "@/lib/jarvis-ui/types";
import { addDays } from "@/lib/time";
import { Button, Input, Select, Textarea, cx } from "@/components/ui";
import { useSurface } from "./context";
import { SmartReply } from "./live";
import { isQuestionnaire, questionnaireReply, QUESTIONNAIRE_MAX } from "@/lib/jarvis-ui/live";

type P<N extends ComponentName> = ComponentRenderProps<PropsOf<N>>;
/** `kind` is the component's catalog name; the owner sees its human label (lib/jarvis-ui/labels.ts), or no tag. */
export function SmartHeader({ kind, title, meta }: { kind: ComponentName; title: string; meta?: ReactNode }) {
  const tag = smartLabel(kind);
  return (
    <header className="svh">
      {tag ? <span className="sv-tag">{tag}</span> : null}
      <h3 className="sv-label">{title}</h3>
      {meta ? <span className="sv-meta">{meta}</span> : null}
    </header>
  );
}
export function DecisionMatrix({ element }: P<"DecisionMatrix">) {
  const p = element.props;
  const s = useSurface();
  const [weights, setWeights] = useState<Record<string, number>>({});
  const totals = matrixTotals(p, weights);
  const h = s.refs[p.ref];
  const applied = s.applied.get(p.ref);
  return (
    <section className="sv" aria-label={p.title}>
      <SmartHeader kind="DecisionMatrix" title={p.title} meta="Weighted comparison" />
      <div className="sv-matrix" role="region" aria-label={`${p.title} scores`} tabIndex={0}>
        <table className="mx">
          <caption className="sr-only">Scores are model estimates</caption>
          <thead>
            <tr>
              <th scope="col">Criterion · weight</th>
              {p.options.map((o) => (
                <th key={o.id} scope="col">
                  {o.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {p.criteria.map((c) => {
              const w = weights[c.id] ?? c.weight;
              return (
                <tr key={c.id}>
                  <th scope="row">
                    <span>{c.label}</span>
                    <span className="sv-weight">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-label={`Lower weight: ${c.label}`}
                        disabled={w <= 1}
                        onClick={() => setWeights({ ...weights, [c.id]: w - 1 })}
                      >
                        −
                      </Button>
                      <output aria-label={`Weight: ${c.label}`}>{w}</output>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-label={`Raise weight: ${c.label}`}
                        disabled={w >= 3}
                        onClick={() => setWeights({ ...weights, [c.id]: w + 1 })}
                      >
                        +
                      </Button>
                    </span>
                  </th>
                  {p.options.map((o) => (
                    <td key={o.id}>{o.scores[c.id]}</td>
                  ))}
                </tr>
              );
            })}
            <tr className="sv-totals">
              <th scope="row">Weighted total</th>
              {totals.map((t) => (
                <td key={t.id}>
                  {t.total}
                  {t.recommended ? <span className="block text-xs text-accent">Recommended</span> : null}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <p className="sv-note">Scores are model estimates · weights stay on this device.</p>
      <div role="group" aria-label={`Choose: ${p.title}`}>
        {p.options.map((o) => {
          const i = matrixIntent(p, o);
          const selected = intentKey((s.staged.get(p.ref) ?? applied?.intent ?? {}) as never) === intentKey(i);
          return (
            <button
              key={o.id}
              type="button"
              className="sv-option"
              aria-pressed={selected}
              disabled={s.readOnly || !isTask(h) || Boolean(applied)}
              onClick={() => s.stage(p.ref, selected ? undefined : i)}
            >
              <strong>{o.label}</strong>
              {o.consequence ? <small>{o.consequence}</small> : null}
            </button>
          );
        })}
      </div>
      {applied ? (
        <p className="sv-note">
          ✓ Recorded{" "}
          <Button size="sm" variant="ghost" aria-label={`Undo: ${p.title}`} onClick={() => s.undo(applied)}>
            Undo
          </Button>
        </p>
      ) : null}
      {s.errors.get(p.ref) ? (
        <p role="alert" className="sv-note text-danger">
          {s.errors.get(p.ref)}
        </p>
      ) : null}
    </section>
  );
}
export function Gantt({ element }: P<"Gantt">) {
  const p = element.props;
  const s = useSurface();
  const live = p.rows.flatMap((r) => {
    const h = s.refs[r.ref];
    return isTask(h) && h.due ? [{ start: r.start ?? h.createdDate ?? addDays(h.due, -7), end: h.due }] : [];
  });
  const from = p.from ?? [addDays(s.today, -7), ...live.map((r) => r.start)].sort()[0]!;
  const to = p.to ?? [addDays(s.today, 30), from, ...live.map((r) => r.end)].sort().at(-1)!;
  return (
    <section className="sv gantt" aria-label={p.title}>
      <SmartHeader kind="Gantt" title={p.title} meta={`${from} → ${to}`} />
      {p.rows.map((row) => {
        const h = s.refs[row.ref];
        if (!isTask(h))
          return (
            <p key={row.ref} className="sv-note">
              Unavailable
            </p>
          );
        const staged = s.staged.get(row.ref);
        const due = staged?.kind === "item.update" ? (staged.patch.targetDate ?? h.due) : h.due;
        const bar = ganttLayout({ ...h, due }, row, from, to, s.today);
        const applied = s.applied.get(row.ref);
        return (
          <div className="sv-gantt-row" key={row.ref}>
            <div className="min-w-0">
              <strong>{h.title}</strong>
              <small className="block text-muted">
                {h.status.replaceAll("_", " ")}
                {bar ? ` · ${bar.end}` : " · no target date"}
              </small>
            </div>
            <div
              className="sv-gantt-lane"
              aria-label={`${h.title}: ${bar ? `${bar.start} to ${bar.end}${bar.tone === "danger" ? ", late" : ""}${bar.milestone ? ", milestone" : ""}` : "no target date"}`}
            >
              {bar ? (
                <>
                  <span
                    className={cx("sv-gantt-bar", bar.milestone && "sv-milestone")}
                    data-tone={bar.tone}
                    style={{ left: `${bar.left}%`, width: bar.milestone ? undefined : `${bar.width}%` }}
                  />
                  <span className="sv-today-line" style={{ left: `${bar.today}%` }} />
                </>
              ) : null}
            </div>
            <label className="sv-date">
              <span className="sr-only">Reschedule: {h.title}</span>
              <Input
                className="w-full min-w-0"
                type="date"
                min={from > s.today ? from : s.today}
                max={to < addDays(s.today, 365) ? to : addDays(s.today, 365)}
                value={due ?? ""}
                disabled={s.readOnly || h.done}
                onChange={(e) => {
                  const date = e.target.value;
                  if (date >= s.today && date >= from && date <= to && date <= addDays(s.today, 365))
                    s.stage(row.ref, date === h.due ? undefined : { kind: "item.update", ref: row.ref, patch: { targetDate: date } });
                }}
              />
            </label>
            {applied ? (
              <Button size="sm" variant="ghost" aria-label={`Undo: ${h.title}`} onClick={() => s.undo(applied)}>
                Undo
              </Button>
            ) : null}
            {s.errors.get(row.ref) ? (
              <p role="alert" className="text-xs text-danger">
                {s.errors.get(row.ref)}
              </p>
            ) : null}
          </div>
        );
      })}
      <p className="sv-note">Dates and bars come from your items. Changing a date stages it; nothing moves until Apply.</p>
    </section>
  );
}
export function BarChart({ element }: P<"BarChart">) {
  const p = element.props;
  const s = useSurface();
  const h = s.refs[p.metric];
  const m = h && "kind" in h && h.kind === "metric" ? h : undefined;
  const series = m?.series ?? [];
  const max = Math.max(1, ...series.map((v) => v.value));
  const label = p.label ?? m?.label ?? "Bar chart";
  return (
    <section className="sv" aria-label={label}>
      <SmartHeader kind="BarChart" title={label} />
      {series.length ? (
        <>
          <div className="bars" role="img" aria-label={`${label}: ${series.map((v) => `${v.label} ${v.value}`).join(", ")}`}>
            {series.map((v, i) => (
              <div key={i} style={{ height: `${Math.max(2, (v.value / max) * 100)}%` }} />
            ))}
          </div>
          <div className="bars-l" aria-hidden="true">
            {series.map((v, i) => (
              <span key={i}>{v.label}</span>
            ))}
          </div>
          <details className="sv-note">
            <summary>Values</summary>
            <table className="mx">
              <caption>
                {label} · {m?.unit ?? "count"}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Day</th>
                  <th scope="col">Value</th>
                </tr>
              </thead>
              <tbody>
                {series.map((v, i) => (
                  <tr key={i}>
                    <th scope="row">{v.label}</th>
                    <td>{v.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
          <p className="sv-note">{m?.note}</p>
        </>
      ) : (
        <p className="sv-note">Unavailable</p>
      )}
    </section>
  );
}
export function ApprovalQueue({ element }: P<"ApprovalQueue">) {
  const s = useSurface();
  const h = s.refs["approvals:pending"];
  const rows = h && "kind" in h && h.kind === "approvals" ? h.rows : [];
  return (
    <section className="sv" aria-label={element.props.title ?? "Approval queue"}>
      <SmartHeader kind="ApprovalQueue" title={element.props.title ?? "Approval queue"} meta={`${rows.length} pending`} />
      <ul>
        {rows.map((r) => (
          <li key={r.id}>
            <Link className="sv-option" href={r.href}>
              <strong>{r.title}</strong>
              <small>{r.detail}</small>
            </Link>
          </li>
        ))}
      </ul>
      {!rows.length ? <p className="sv-note">{s.hydrating ? "Loading…" : "Nothing pending"}</p> : null}
      <p className="sv-note">Read-only. Approve or answer in the existing flow.</p>
    </section>
  );
}
export function SmartForm({ element }: P<"Form">) {
  const p = element.props;
  const s = useSurface();
  const uid = useId();
  const [values, setValues] = useState<FormValues>(() => Object.fromEntries(p.fields.filter((f) => f.proposed !== undefined).map((f) => [f.id, f.proposed!])));
  const [edited, setEdited] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState("");
  // A questionnaire (nothing to create or update) answers the conversation: Submit sends the answers as the owner's reply.
  const reply = useContext(SmartReply);
  const questionnaire = isQuestionnaire(p);
  // Sent state is this form's own (not the surface's saved state: an identical check-in later in the thread shares it).
  const [sentAt, setSentAt] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const set = (id: string, v: string | boolean | number) => {
    setValues({ ...values, [id]: v });
    setEdited(new Set([...edited, id]));
  };
  return (
    <section className="sv" aria-label={p.title}>
      <SmartHeader kind="Form" title={p.title} meta="Questionnaire" />
      <form
        className="sv-form grid-cols-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (p.fields.some((f) => f.required && (values[f.id] === undefined || values[f.id] === ""))) {
            setNotice("Complete the required fields.");
            return;
          }
          if (questionnaire) {
            if (!reply) {
              setNotice("Reply in the chat with your answers.");
              return;
            }
            if (sending) return;
            const text = questionnaireReply(p, values);
            if (text.length > QUESTIONNAIRE_MAX) {
              setNotice(
                `Your answers are too long to send as one reply (${QUESTIONNAIRE_MAX.toLocaleString("en-US")} characters). Shorten them and submit again.`,
              );
              return;
            }
            setSending(true);
            void reply(text)
              .then((sent) => {
                if (!sent) return setNotice("Not sent. Try again.");
                setSentAt(new Date().toISOString());
                setNotice("Sent to the chat as your reply.");
              })
              .finally(() => setSending(false));
            return;
          }
          const intents = formIntents(p, values);
          // Re-submit replaces this form's previous staged creates, never duplicates them.
          for (const key of s.staged.keys()) if (key.startsWith(`form:${p.title}:`)) s.stage(key, undefined);
          intents.forEach((i) => s.stage(`form:${p.title}:${intentTarget(i)}`, i));
          setNotice(
            intents.length ? "Submitted for review in the change tray. Nothing has been written." : "Add an item for next week and choose its destination.",
          );
        }}
      >
        {p.fields.map((f) => {
          const id = `${uid}-${f.id}`;
          const proposed = f.proposed !== undefined && !edited.has(f.id);
          const common = {
            id,
            disabled: s.readOnly,
            required: f.required,
            className: "w-full min-w-0",
            "aria-describedby": proposed ? `${id}-provenance` : undefined,
          };
          return (
            <div key={f.id} className={cx("sv-field", proposed && "sv-proposed")}>
              <label htmlFor={id}>
                {f.label}
                {f.required ? " (required)" : ""}
              </label>
              {f.kind === "textarea" ? (
                <Textarea {...common} rows={3} maxLength={2000} value={String(values[f.id] ?? "")} onChange={(e) => set(f.id, e.target.value)} />
              ) : f.kind === "choice" || f.kind === "scale" ? (
                <Select
                  {...common}
                  value={String(values[f.id] ?? "")}
                  onChange={(e) => set(f.id, f.kind === "scale" ? Number(e.target.value) : e.target.value)}
                >
                  <option value="">Choose…</option>
                  {(f.kind === "scale" ? [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) })) : (f.options ?? [])).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              ) : f.kind === "toggle" ? (
                <input {...common} className="h-6 w-6" type="checkbox" checked={values[f.id] === true} onChange={(e) => set(f.id, e.target.checked)} />
              ) : (
                <Input {...common} type="text" maxLength={200} value={String(values[f.id] ?? "")} onChange={(e) => set(f.id, e.target.value)} />
              )}
              {proposed ? (
                <small id={`${id}-provenance`} className="text-ai">
                  proposed · from Jarvis data, editable
                </small>
              ) : null}
            </div>
          );
        })}
        <Button type="submit" className="max-w-full whitespace-normal" disabled={s.readOnly || (questionnaire && !!sentAt)} loading={sending}>
          {p.submit.label}
        </Button>
        <p className="text-xs text-muted" role="status">
          {notice ||
            (questionnaire
              ? sentAt
                ? "Sent to the chat as your reply."
                : "Submit sends your answers to the chat."
              : "Submit stages changes for Apply → Undo.")}
        </p>
      </form>
    </section>
  );
}
