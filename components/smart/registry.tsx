"use client";

import Link from "next/link";
import type { ComponentRegistry, ComponentRenderProps } from "@json-render/react";
import type { ComponentName, PropsOf, RowAction } from "@/lib/jarvis-ui/catalog";
import { actionsForRow, intentChip, intentKey, intentTarget, rowIntent, suggestedAction } from "@/lib/jarvis-ui/intents";
import type { HydratedRef } from "@/lib/jarvis-ui/types";
import { addDays, daysBetween } from "@/lib/time";
import { Badge, Button, OverflowMenu, cx, type MenuItem } from "@/components/ui";
import { InlineText, useSurface } from "./context";

type P<N extends ComponentName> = ComponentRenderProps<PropsOf<N>>;

const SUGGESTION_LABEL: Record<RowAction, string> = { done: "Done", week: "This week", snooze: "Reschedule", drop: "Drop", promote: "Promote" };
const BUCKET_TONE = { do_week: "accent", reschedule: "warn", snooze: "warn", drop: "neutral", keep: "neutral", done: "ok" } as const;

function fmtDay(d: string) {
  return new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

function DuePill({ due, today }: { due?: string; today: string }) {
  if (!due) return null;
  const late = daysBetween(due, today);
  if (late > 0) return <Badge tone="danger">{late === 1 ? "1 day late" : `${late} days late`}</Badge>;
  return <Badge tone={late === 0 ? "warn" : "neutral"}>{late === 0 ? "Today" : fmtDay(due)}</Badge>;
}

function title(h: HydratedRef | undefined) {
  return h && "title" in h ? h.title : undefined;
}

function TaskRow({ list, row }: { list: PropsOf<"TaskList">; row: PropsOf<"TaskList">["rows"][number] }) {
  const s = useSurface();
  const h = s.refs[row.ref];
  const name = title(h) ?? (s.hydrating ? "Loading…" : "Unavailable");
  const staged = s.staged.get(row.ref);
  const applied = s.applied.get(row.ref);
  const error = s.errors.get(row.ref);
  const unavailable = !h || "unavailable" in h;
  const sug = suggestedAction(row);
  const sugIntent = sug ? rowIntent(list, row, sug, s.today) : undefined;
  const isSug = Boolean(staged && sugIntent && intentKey(staged) === intentKey(sugIntent));
  const stage = (a: RowAction, date?: string) => s.stage(row.ref, rowIntent(list, row, a, s.today, date));
  const acts = actionsForRow(list, row);
  const items: MenuItem[] = [];
  for (const a of acts) {
    if (a === "snooze") {
      items.push({ label: "Snooze to tomorrow", onSelect: () => stage("snooze", addDays(s.today, 1)) });
      items.push({ label: "Snooze one week", onSelect: () => stage("snooze", addDays(s.today, 7)) });
      if (row.suggestedDate && row.suggestedDate >= s.today)
        items.push({ label: `Snooze to ${fmtDay(row.suggestedDate)}`, onSelect: () => stage("snooze", row.suggestedDate) });
    } else
      items.push({
        label: a === "week" ? "Do this week" : a === "drop" ? "Drop (mark done, noted)" : a === "promote" ? "Promote to a work item" : "Mark done",
        onSelect: () => stage(a),
      });
  }
  if (staged) items.push({ label: "Don’t change", onSelect: () => s.stage(row.ref, undefined) });
  const done = h && "done" in h && h.done;
  return (
    <li
      className={cx("smart-row flex items-center gap-2 border-t border-line px-3 py-2", staged && "bg-accent-soft/50", (applied || done) && "opacity-70")}
      data-ref={row.ref}
    >
      <div className="min-w-0 flex-1">
        <p className={cx("truncate font-medium", (applied?.intent as { kind?: string })?.kind?.match(/complete|drop/) && "line-through")}>{name}</p>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted" data-dynamic>
          {h && "kind" in h ? <DuePill due={h.due} today={s.today} /> : null}
          {h && "where" in h && h.where ? <span>{h.where}</span> : null}
          {row.reason ? <span className="min-w-0 truncate">· {row.reason}</span> : null}
          {unavailable && !s.hydrating ? (
            <span>{h && "unavailable" in h && h.unavailable === "finance" ? "Finance is never shown to AI" : "Not available"}</span>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="mt-0.5 text-xs text-danger">
            {error}
          </p>
        ) : null}
      </div>
      {s.readOnly || unavailable ? null : applied ? (
        <span className="flex shrink-0 items-center gap-1 text-xs">
          <span className="text-ok">✓ {applied.message}</span>
          <Button size="sm" variant="ghost" busy={s.undoing === applied.intentHash} onClick={() => s.undo(applied)} aria-label={`Undo: ${name}`}>
            Undo
          </Button>
        </span>
      ) : (
        <span className="flex shrink-0 items-center gap-1">
          {sug && sugIntent ? (
            <Button
              size="sm"
              variant={isSug ? "primary" : "secondary"}
              aria-pressed={isSug}
              aria-label={`${SUGGESTION_LABEL[sug]}${sugIntent.kind === "todo.snooze" ? ` (${fmtDay(sugIntent.date)})` : ""}: ${name}`}
              onClick={() => s.stage(row.ref, isSug ? undefined : sugIntent)}
              className={cx(!isSug && "border-dashed")}
            >
              {SUGGESTION_LABEL[sug]}
            </Button>
          ) : null}
          {staged && !isSug ? <Badge tone="accent">{intentChip(staged)}</Badge> : null}
          <OverflowMenu label={`More actions for ${name}`} items={items} />
        </span>
      )}
    </li>
  );
}

function TaskList({ element }: P<"TaskList">) {
  const list = element.props;
  const s = useSurface();
  const pending = list.rows.filter((r) => {
    const sug = suggestedAction(r);
    const h = s.refs[r.ref];
    return sug && h && !("unavailable" in h) && !s.applied.get(r.ref) && !s.staged.get(r.ref);
  });
  return (
    <section className="overflow-hidden rounded-[10px] border border-line" aria-label={list.title}>
      <header className="flex items-center gap-2 bg-surface-2 px-3 py-1.5">
        <h3 className="flex-1 text-sm font-semibold">
          {list.title} <span className="text-muted">{list.rows.length}</span>
        </h3>
        {list.bucket ? <Badge tone={BUCKET_TONE[list.bucket]}>{list.bucket.replace("_", " ")}</Badge> : null}
        {!s.readOnly && pending.length > 1 ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              for (const r of pending) s.stage(r.ref, rowIntent(list, r, suggestedAction(r)!, s.today));
            }}
          >
            Accept {pending.length} suggestions
          </Button>
        ) : null}
      </header>
      <ul>
        {list.rows.map((r) => (
          <TaskRow key={r.ref} list={list} row={r} />
        ))}
      </ul>
    </section>
  );
}

function DecisionCard({ element }: P<"DecisionCard">) {
  const p = element.props;
  const s = useSurface();
  const key = `decision:${p.title}`;
  const staged = s.staged.get(key);
  const appliedOpt = p.options.find(
    (o) => o.intent && s.applied.get(intentTarget(o.intent)) && intentKey(s.applied.get(intentTarget(o.intent))!.intent as never) === intentKey(o.intent),
  );
  return (
    <section className="rounded-[10px] border border-line p-3" aria-label={p.title}>
      <h3 className="font-semibold">{p.title}</h3>
      {p.context ? (
        <p className="mt-1 text-sm text-muted">
          <InlineText text={p.context} />
        </p>
      ) : null}
      <div role="radiogroup" aria-label={p.title} className="mt-2 grid gap-1.5">
        {p.options.map((o) => {
          const on = Boolean((staged && o.intent && intentKey(staged) === intentKey(o.intent)) || appliedOpt === o);
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={s.readOnly || Boolean(appliedOpt) || !o.intent}
              onClick={() => s.stage(key, on ? undefined : o.intent)}
              className={cx(
                "press min-h-11 rounded-[9px] border px-3 py-2 text-left sm:min-h-10",
                on ? "border-accent bg-accent-soft" : "border-line bg-surface hover:bg-surface-2",
              )}
            >
              <span className="font-medium">{o.label}</span> {o.recommended ? <Badge tone="ok">Recommended</Badge> : null}
              {o.consequence ? <span className="block text-xs text-muted">{o.consequence}</span> : null}
            </button>
          );
        })}
      </div>
      {appliedOpt ? <p className="mt-2 text-xs text-ok">✓ Recorded “{appliedOpt.label}”</p> : null}
    </section>
  );
}

function Checklist({ element }: P<"Checklist">) {
  const p = element.props;
  const s = useSurface();
  const id = (step: string) => `${p.title}::${step}`;
  const done = p.steps.filter((x) => s.checks.includes(id(x.id))).length;
  return (
    <section className="rounded-[10px] border border-line" aria-label={p.title}>
      <header className="flex items-center gap-2 px-3 pt-2">
        <h3 className="flex-1 text-sm font-semibold">{p.title}</h3>
        <span className="text-xs text-muted">
          {done}/{p.steps.length} done
        </span>
      </header>
      <div className="mx-3 my-2 h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
        <div className="h-full bg-ok transition-[width]" style={{ width: `${(done / p.steps.length) * 100}%` }} />
      </div>
      <ul>
        {p.steps.map((step, i) => {
          const checked = s.checks.includes(id(step.id));
          return (
            <li key={step.id} className="border-t border-line">
              <label className="flex min-h-11 cursor-pointer items-start gap-2.5 px-3 py-2 sm:min-h-10">
                <input type="checkbox" className="mt-1 h-4 w-4" checked={checked} disabled={s.readOnly} onChange={() => s.toggleCheck(id(step.id))} />
                <span className="min-w-0 flex-1">
                  <span className={cx("font-medium", checked && "text-muted line-through")}>
                    {i + 1}. {step.label}
                  </span>{" "}
                  {step.runBy === "you" ? <Badge tone="warn">You run</Badge> : step.runBy === "agent" ? <Badge tone="accent">Agent</Badge> : null}
                  {step.detail ? (
                    <span className="block text-xs text-muted">
                      <InlineText text={step.detail} />
                    </span>
                  ) : null}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <p className="px-3 pb-2 text-xs text-muted">Ticking records a step; it never runs it.</p>
    </section>
  );
}

function Gauge({ element }: P<"Gauge">) {
  const p = element.props;
  const pct = Math.max(0, Math.min(1, p.value / p.max));
  const tone = pct >= 0.9 ? "bg-danger" : pct >= 0.7 ? "bg-warn" : "bg-ok";
  return (
    <div className="rounded-[10px] border border-line px-3 py-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{p.label}</p>
      <p className="text-lg font-bold tabular-nums">
        {p.value}
        {p.unit ?? ""}{" "}
        <span className="text-xs font-medium text-muted">
          / {p.max}
          {p.unit ?? ""}
        </span>
      </p>
      <div
        role="meter"
        aria-label={p.label}
        aria-valuemin={0}
        aria-valuemax={p.max}
        aria-valuenow={p.value}
        className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2"
      >
        <div className={cx("h-full", tone)} style={{ width: `${pct * 100}%` }} />
      </div>
      <p className="mt-1 text-xs text-muted">{p.note ? `${p.note} · ` : ""}Estimate from the reply</p>
    </div>
  );
}

function Table({ element }: P<"Table">) {
  const p = element.props;
  const s = useSurface();
  return (
    <div className="relative">
      <div className="overflow-x-auto rounded-[10px] border border-line">
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-xs text-muted">
            <tr>
              {p.columns.map((c) => (
                <th key={c.key} scope="col" className={cx("px-3 py-1.5 font-semibold", c.align === "right" ? "text-right" : "text-left")}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {p.rows.map((r, i) => (
              <tr key={i} className="border-t border-line">
                {p.columns.map((c, ci) => (
                  <td key={c.key} className={cx("px-3 py-1.5", c.align === "right" && "text-right tabular-nums")}>
                    {ci === 0 && r.ref && title(s.refs[r.ref]) ? title(s.refs[r.ref]) : String(r.cells[c.key] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ItemRef({ element }: P<"ItemRef">) {
  const s = useSurface();
  const h = s.refs[element.props.ref];
  if (!h || "unavailable" in h) return <span className="chip text-muted">Unavailable</span>;
  return h.href ? (
    <Link href={h.href} className="chip">
      {h.title}
    </Link>
  ) : (
    <span className="chip">{h.title}</span>
  );
}

const TONE_BORDER = { neutral: "", warn: "border-l-warn", ok: "border-l-ok", accent: "border-l-accent" } as const;

export const registry: ComponentRegistry = {
  Stack: ({ element, children }: P<"Stack">) => (
    <div className={cx("flex", element.props.direction === "row" ? "flex-row flex-wrap" : "flex-col", element.props.gap === "sm" ? "gap-1.5" : "gap-3")}>
      {children}
    </div>
  ),
  Section: ({ element, children }: P<"Section">) => (
    <section className={cx("space-y-2", element.props.tone && element.props.tone !== "neutral" && cx("border-l-2 pl-2.5", TONE_BORDER[element.props.tone]))}>
      <header>
        <h3 className="text-sm font-semibold">{element.props.title}</h3>
        {element.props.subtitle ? <p className="text-xs text-muted">{element.props.subtitle}</p> : null}
      </header>
      {children}
    </section>
  ),
  Text: ({ element }: P<"Text">) => (
    <p className={cx(element.props.variant === "meta" ? "text-xs text-muted" : element.props.variant === "lead" ? "font-medium" : "text-sm")}>
      <InlineText text={element.props.text} />
    </p>
  ),
  Callout: ({ element }: P<"Callout">) => (
    <div
      role="note"
      className={cx(
        "rounded-[10px] border px-3 py-2 text-sm",
        element.props.tone === "warn" ? "border-warn bg-warn-soft" : element.props.tone === "ok" ? "border-ok bg-ok-soft" : "border-line bg-surface-2",
      )}
    >
      <p className="font-semibold">{element.props.title}</p>
      {element.props.text ? (
        <p>
          <InlineText text={element.props.text} />
        </p>
      ) : null}
    </div>
  ),
  Divider: () => <hr className="border-line" />,
  TaskList,
  DecisionCard,
  Checklist,
  Gauge,
  Table,
  ItemRef,
};
