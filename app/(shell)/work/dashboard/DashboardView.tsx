"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { Badge, Button, Card, Dialog, Empty, ErrorNote, Field, PageHeader, Spinner, cx, inputCls } from "@/components/ui";
import { CustomHtmlWidget } from "@/components/work/CustomHtmlWidget";
import { Gantt } from "@/components/work/Gantt";
import { StatusBadge, StatusDot, fmtDate, useGithubAutoRefresh, useWorkMutation } from "@/components/work/common";
import {
  CUSTOM_HTML_MAX_BYTES,
  safeHref,
  utf8Bytes,
  WIDGET_KINDS,
  WIDGET_LABELS,
  WIDGET_SIZES,
  type DashboardResponse,
  type DashboardWidget,
  type MapNode,
  type WidgetConfig,
  type WidgetKind,
  type WidgetSize,
} from "@/lib/work";

const SIZE_CLS: Record<WidgetSize, string> = { sm: "lg:col-span-1", md: "md:col-span-2 lg:col-span-2", lg: "md:col-span-2 lg:col-span-3" };
const SIZE_LABEL: Record<WidgetSize, string> = { sm: "Small", md: "Medium", lg: "Large" };
const SCOPED: WidgetKind[] = [
  "priorities",
  "next_actions",
  "awaiting_validation",
  "recently_settled",
  "timeline",
  "project_map",
  "custom_html",
  "validation_overdue",
];

export function DashboardView() {
  const q = useQuery({ queryKey: ["work", "dashboard"], queryFn: () => api.get<DashboardResponse>("/api/work/dashboard") });
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [configuring, setConfiguring] = useState<DashboardWidget | null>(null);
  useGithubAutoRefresh(!!q.data?.githubRefresh);
  return (
    <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6">
      <PageHeader
        title="Dashboard"
        subtitle="Your work at a glance. Widgets read Jarvis work data only."
        actions={
          <>
            {editing ? (
              <Button size="sm" onClick={() => setAdding(true)}>
                Add widget
              </Button>
            ) : null}
            <Button size="sm" variant={editing ? "primary" : "secondary"} aria-pressed={editing} onClick={() => setEditing((e) => !e)}>
              {editing ? "Done editing" : "Edit dashboard"}
            </Button>
          </>
        }
      />
      {q.error ? <ErrorNote error={q.error} retry={() => q.refetch()} /> : null}
      {q.isPending ? (
        <Spinner label="Loading dashboard…" />
      ) : q.data ? (
        q.data.widgets.length ? (
          <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {q.data.widgets.map((w, i) => (
              <WidgetCard key={w.id} w={w} editing={editing} first={i === 0} last={i === q.data.widgets.length - 1} onConfigure={() => setConfiguring(w)} />
            ))}
          </ul>
        ) : (
          <Empty title="No widgets" action={<Button onClick={() => (setEditing(true), setAdding(true))}>Add widget</Button>} />
        )
      ) : null}
      {q.data && adding ? <WidgetDialog areas={q.data.areas} onClose={() => setAdding(false)} /> : null}
      {q.data && configuring ? <WidgetDialog areas={q.data.areas} widget={configuring} onClose={() => setConfiguring(null)} /> : null}
    </div>
  );
}

function WidgetCard({
  w,
  editing,
  first,
  last,
  onConfigure,
}: {
  w: DashboardWidget;
  editing: boolean;
  first: boolean;
  last: boolean;
  onConfigure: () => void;
}) {
  const url = `/api/work/dashboard/widgets/${encodeURIComponent(w.id)}`;
  const move = useWorkMutation((direction: "up" | "down") => api.patch(url, { direction }));
  const remove = useWorkMutation(() => api.del(url), { ok: "Widget removed" });
  const headingId = `widget-${w.id}`;
  return (
    <li className={cx("min-w-0", SIZE_CLS[w.size])}>
      <Card as="section" aria-labelledby={headingId} className="h-full" data-widget={w.kind}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 id={headingId} className="font-semibold">
            {w.title}
          </h2>
          {editing ? (
            <div className="flex flex-wrap gap-1">
              <Button size="sm" variant="ghost" disabled={first} onClick={() => move.mutate("up")} aria-label={`Move ${w.title} earlier`}>
                ↑
              </Button>
              <Button size="sm" variant="ghost" disabled={last} onClick={() => move.mutate("down")} aria-label={`Move ${w.title} later`}>
                ↓
              </Button>
              <Button size="sm" variant="ghost" onClick={onConfigure} aria-label={`Configure ${w.title}`}>
                Configure
              </Button>
              <Button size="sm" variant="ghost" onClick={() => remove.mutate(undefined)} aria-label={`Remove ${w.title}`}>
                Remove
              </Button>
            </div>
          ) : null}
        </div>
        <WidgetBody w={w} />
      </Card>
    </li>
  );
}

function WidgetBody({ w }: { w: DashboardWidget }) {
  const d = w.data;
  if (d.kind === "items") {
    if (!d.items.length) return <p className="text-sm text-muted">Nothing here right now.</p>;
    return (
      <ul className="divide-y divide-line">
        {d.items.map((i) => (
          <li key={i.id} className="py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Link href={`/work?item=${encodeURIComponent(i.id)}`} className="min-w-0 font-medium break-words hover:underline">
                {i.title}
              </Link>
              <StatusBadge status={i.status} auto={i.settledKind === "auto"} />
            </div>
            {w.kind === "next_actions" || w.kind === "priorities" ? <p className="text-sm break-words text-muted">{i.nextAction || "No next action"}</p> : null}
            {i.detail ? <p className="text-sm break-words text-muted">{i.detail}</p> : null}
            {i.targetDate && w.kind === "priorities" ? <p className="text-xs text-muted">Target {fmtDate(i.targetDate)}</p> : null}
          </li>
        ))}
      </ul>
    );
  }
  if (d.kind === "overdue")
    return (
      <div>
        <p className="flex items-baseline gap-2">
          <span className={cx("text-3xl font-semibold tabular-nums", d.count ? "text-danger" : "")} data-testid="overdue-count">
            {d.count}
          </span>
          <span className="text-sm text-muted">validation{d.count === 1 ? "" : "s"} past due</span>
        </p>
        {d.items.length ? (
          <ul className="mt-2 divide-y divide-line">
            {d.items.map((i) => (
              <li key={i.id} className="py-2">
                <Link href={`/work?item=${encodeURIComponent(i.id)}`} className="font-medium break-words hover:underline">
                  {i.title}
                </Link>
                {i.detail ? <p className="text-sm break-words text-muted">{i.detail}</p> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-muted">Nothing overdue.</p>
        )}
      </div>
    );
  if (d.kind === "timeline")
    return d.rows.length ? <Gantt rows={d.rows} today={d.today} zoom="month" compact /> : <p className="text-sm text-muted">No dated work.</p>;
  if (d.kind === "map") return d.root ? <MiniMap node={d.root} /> : <p className="text-sm text-muted">Choose an area or project in Configure.</p>;
  if (d.kind === "metric") {
    const href = w.config.href ? safeHref(w.config.href) : null;
    return (
      <div>
        <p className="text-3xl font-semibold tabular-nums">{w.config.value || "—"}</p>
        {w.config.label ? <p className="text-sm text-muted">{w.config.label}</p> : null}
        {w.config.target ? <Badge className="mt-2">Target {w.config.target}</Badge> : null}
        {href ? (
          <p className="mt-2 text-sm">
            {href.startsWith("/") ? (
              <Link href={href} className="text-accent underline">
                Details
              </Link>
            ) : (
              <a href={href} target="_blank" rel="noreferrer noopener" className="text-accent underline">
                Details<span className="sr-only"> (opens in a new tab)</span>
              </a>
            )}
          </p>
        ) : null}
        <p className="mt-2 text-xs text-muted">Entered manually.</p>
      </div>
    );
  }
  return <CustomHtmlWidget html={w.config.html ?? ""} title={w.title} snapshot={d.snapshot} />;
}

function MiniMap({ node, depth = 0 }: { node: MapNode; depth?: number }) {
  return (
    <div className={depth ? "border-l border-line pl-3" : ""}>
      <Link href={`/work?item=${encodeURIComponent(node.id)}`} className="flex min-h-8 items-center gap-2 text-sm hover:underline">
        <StatusDot status={node.status} />
        <span className={cx("break-words", depth === 0 && "font-semibold")}>{node.title}</span>
      </Link>
      {node.children.length ? (
        <ul className="space-y-0.5">
          {node.children.map((c) => (
            <li key={c.id}>
              <MiniMap node={c} depth={depth + 1} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function WidgetDialog({ areas, widget, onClose }: { areas: DashboardResponse["areas"]; widget?: DashboardWidget; onClose: () => void }) {
  const [kind, setKind] = useState<WidgetKind>(widget?.kind ?? "priorities");
  const [title, setTitle] = useState(widget?.title ?? "");
  const [size, setSize] = useState<WidgetSize>(widget?.size ?? "md");
  const [c, setC] = useState<WidgetConfig>(widget?.config ?? {});
  const body = { title: title.trim() || undefined, size, config: clean(kind, c) };
  const save = useWorkMutation(
    () =>
      widget ? api.patch(`/api/work/dashboard/widgets/${encodeURIComponent(widget.id)}`, body) : api.post("/api/work/dashboard/widgets", { kind, ...body }),
    {
      ok: widget ? "Widget saved" : "Widget added",
      onSuccess: onClose,
    },
  );
  const htmlBytes = utf8Bytes(c.html ?? "");
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={widget ? `Configure ${widget.title}` : "Add widget"}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="widget-form" busy={save.isPending} disabled={htmlBytes > CUSTOM_HTML_MAX_BYTES}>
            {widget ? "Save widget" : "Add widget"}
          </Button>
        </>
      }
    >
      <form
        id="widget-form"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(undefined);
        }}
      >
        {!widget ? (
          <Field id="wg-kind" label="Widget type">
            <select id="wg-kind" data-autofocus className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as WidgetKind)}>
              {WIDGET_KINDS.map((k) => (
                <option key={k} value={k}>
                  {WIDGET_LABELS[k]}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="wg-title" label="Title">
            <input id="wg-title" className={inputCls} value={title} placeholder={WIDGET_LABELS[kind]} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field id="wg-size" label="Size">
            <select id="wg-size" className={inputCls} value={size} onChange={(e) => setSize(e.target.value as WidgetSize)}>
              {WIDGET_SIZES.map((s) => (
                <option key={s} value={s}>
                  {SIZE_LABEL[s]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {SCOPED.includes(kind) ? (
          <Field id="wg-root" label="Area or project" hint={kind === "project_map" ? "Required for the map." : "Leave empty for all of your work."}>
            <select id="wg-root" className={inputCls} value={c.rootId ?? ""} onChange={(e) => setC({ ...c, rootId: e.target.value || null })}>
              <option value="">All work</option>
              {areas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        {kind === "metric" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="wg-value" label="Value">
              <input id="wg-value" className={inputCls} value={c.value ?? ""} onChange={(e) => setC({ ...c, value: e.target.value })} />
            </Field>
            <Field id="wg-label" label="Label">
              <input id="wg-label" className={inputCls} value={c.label ?? ""} onChange={(e) => setC({ ...c, label: e.target.value })} />
            </Field>
            <Field id="wg-target" label="Target">
              <input id="wg-target" className={inputCls} value={c.target ?? ""} onChange={(e) => setC({ ...c, target: e.target.value })} />
            </Field>
            <Field id="wg-href" label="Link (optional)">
              <input
                id="wg-href"
                className={inputCls}
                value={c.href ?? ""}
                onChange={(e) => setC({ ...c, href: e.target.value })}
                placeholder="https://… or /work"
              />
            </Field>
          </div>
        ) : null}
        {kind === "custom_html" ? (
          <>
            <Field
              id="wg-html"
              label="HTML"
              hint={`Runs in a sandboxed frame with no network access, cookies or Jarvis APIs. ${Math.ceil(htmlBytes / 1024)} of 100 KB.`}
              error={htmlBytes > CUSTOM_HTML_MAX_BYTES ? "Too large: custom HTML is limited to 100 KB." : undefined}
            >
              <textarea
                id="wg-html"
                spellCheck={false}
                className={`${inputCls} min-h-48 font-mono text-sm`}
                value={c.html ?? ""}
                onChange={(e) => setC({ ...c, html: e.target.value })}
              />
            </Field>
            <label className="flex min-h-11 items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={!!c.injectData} onChange={(e) => setC({ ...c, injectData: e.target.checked })} />
              <span>
                Send this widget a read-only snapshot of the chosen work (titles, statuses, dates, next actions) via <code>postMessage</code> (
                <code>{'{ type: "jarvis.work.snapshot", data }'}</code>). No links or finance data.
              </span>
            </label>
          </>
        ) : null}
      </form>
    </Dialog>
  );
}

function clean(kind: WidgetKind, c: WidgetConfig): WidgetConfig {
  const out: WidgetConfig = {};
  if (SCOPED.includes(kind) && c.rootId) out.rootId = c.rootId;
  if (kind === "metric") Object.assign(out, { value: c.value ?? "", label: c.label ?? "", target: c.target ?? "", ...(c.href ? { href: c.href } : {}) });
  if (kind === "custom_html") Object.assign(out, { html: c.html ?? "", injectData: !!c.injectData });
  return out;
}
