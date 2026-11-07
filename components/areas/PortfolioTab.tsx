"use client";

import Link from "next/link";
import { useMemo, useState, type JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { ChipButton, ChipSelect, SectionHeader } from "@/components/ui/kit";
import { Button, Dialog } from "@/components/ui";
import { MAP_KEY, mapWorkItems, type MapLink, type MapResponse } from "@/components/map/MapView";
import { NeedsYouSection, useDecisions } from "@/components/map/Decisions";
import { StatusDot, fmtDate, useWorkMutation } from "@/components/work/common";
import { UndoBar, type UndoOp } from "@/components/work/UndoBar";
import { MAP_BUCKET_LABELS } from "@/lib/map-rollup";
import { PORTFOLIO_LANES, portfolioRows, portfolioTags, shortVersion, type PortfolioLane, type PortfolioRow } from "@/lib/portfolio-view";
import type { ImportPlan } from "@/lib/portfolio-import";
import "@/components/map/map.css";
import "./portfolio.css";

type ReleaseInfo = { version: string; startedAt: string; migrations: number | null; migratedAt: string | null };
type ImportResult = { plan: ImportPlan; applied: { created: number; updated: number; links: number } | null; op?: UndoOp };

const LANE_TONE: Record<PortfolioLane, string> = { owner: "wn", inflight: "ac", next: "inf", live: "ok", backlog: "neutral" };
const LANE_MAX = 4;
const REPO = "https://github.com/NickBolles/Personal-dashboard";

function linkLabel(l: MapLink) {
  const m = /github\.com\/[^/]+\/[^/]+\/(pull|issues)\/(\d+)/.exec(l.url);
  if (m) return `${m[1] === "pull" ? "PR" : "#"}${m[1] === "pull" ? " #" : ""}${m[2]}`;
  if (/\/v\/[^/]+/.test(l.url)) return l.title || "Board";
  return l.title || l.url.replace(/^https?:\/\//, "").slice(0, 24);
}

/**
 * The Portfolio tab on the Areas landing (Phase 4): every project across
 * areas in status lanes, what waits on you, what is running in prod, and links
 * to boards/PRs. Replaces the published portfolio map board.
 */
export function PortfolioTab({ onOpen }: { onOpen?: (id: string) => void }): JSX.Element {
  const q = useQuery({ queryKey: MAP_KEY, queryFn: () => api.get<MapResponse>("/api/work/overview") });
  const rel = useQuery({ queryKey: ["work", "portfolio", "release"], queryFn: () => api.get<ReleaseInfo>("/api/work/portfolio"), staleTime: 60_000 });
  const dq = useDecisions();
  const [tag, setTag] = useState("");
  const [importing, setImporting] = useState(false);
  const [op, setOp] = useState<UndoOp | null>(null);
  const items = useMemo(() => mapWorkItems(q.data?.items ?? []), [q.data]);
  const tags = useMemo(() => portfolioTags(items), [items]);
  const rows = useMemo(() => portfolioRows(items, { tag: tag || undefined }), [items, tag]);
  const updated = rows.reduce<string | null>((m, r) => (!m || r.updatedAt > m ? r.updatedAt : m), null);
  const open = rows.reduce((n, r) => n + r.open, 0);

  return (
    <div className="mp-root pf-root min-w-0 pb-24" data-testid="portfolio">
      <header className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="text-lg leading-tight font-semibold tracking-tight">Portfolio</h2>
          <p className="mt-0.5 text-[13px] text-muted" data-dynamic>
            {rows.length} {rows.length === 1 ? "project" : "projects"} · {open} open{updated ? ` · updated ${fmtDate(updated)}` : ""}
          </p>
        </div>
        {/* min-w-0 + max-w-full: at 320 px / 200 % text the w-40 Group chip is 320 px; without a cap here the toolbar sized to it and scrolled the page sideways. */}
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
          {tags.length ? (
            <ChipSelect aria-label="Group" value={tag} active={!!tag} onChange={(e) => setTag(e.target.value)} className="w-40 max-w-full [&>select]:w-full">
              <option value="">All groups</option>
              {tags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </ChipSelect>
          ) : null}
          <ChipButton type="button" onClick={() => setImporting(true)}>
            Import map JSON
          </ChipButton>
          <a href="/api/work/overview/export" download className="k-pick inline-flex items-center px-3 text-[13px]">
            Export JSON
          </a>
        </div>
      </header>

      <ReleaseStrip info={rel.data} error={!!rel.error} />

      {q.error ? <p className="text-sm text-danger">Couldn&apos;t load the portfolio: {(q.error as Error).message}</p> : null}
      {!q.data && !q.error ? (
        <p className="text-sm text-muted" role="status">
          Loading the portfolio…
        </p>
      ) : null}

      {q.data ? (
        <div className="pf-land">
          <section aria-labelledby="pf-projects-h" className="min-w-0">
            <SectionHeader id="pf-projects-h" label="Projects" count={rows.length} />
            {rows.length ? (
              <ul className="pf-rows" data-testid="portfolio-rows">
                {rows.map((r) => (
                  <ProjectRow key={r.id} row={r} links={q.data.links} onOpen={onOpen} />
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-muted">{tag ? "No open work with that group." : "No project work yet. Import the portfolio map JSON to start."}</p>
            )}
          </section>
          <aside aria-label="Waiting on you" className="pf-side flex min-w-0 flex-col gap-3">
            <NeedsYouSection entries={dq.data?.entries ?? q.data.decisions.entries} id="pf-needs-you-h" limit={6} />
          </aside>
        </div>
      ) : null}

      {importing ? <ImportDialog onClose={() => setImporting(false)} onApplied={(o) => setOp(o ?? null)} /> : null}
      {op ? <UndoBar key={op.id} op={op} onDone={() => setOp(null)} /> : null}
    </div>
  );
}

function ReleaseStrip({ info, error }: { info?: ReleaseInfo; error: boolean }) {
  if (error || !info) return null;
  const sha = shortVersion(info.version);
  const isSha = sha !== info.version || /^[0-9a-f]{7}$/i.test(sha);
  return (
    <section aria-label="Release" className="pf-release mb-4" data-testid="portfolio-release">
      <span className="pf-release-dot" aria-hidden="true" />
      <span className="font-medium">Live</span>
      {isSha ? (
        <a href={`${REPO}/commit/${info.version}`} className="font-mono text-accent hover:underline" target="_blank" rel="noreferrer">
          {sha}
        </a>
      ) : (
        <span className="font-mono">{sha}</span>
      )}
      <span className="text-muted" data-dynamic>
        since {fmtDate(info.startedAt)}
      </span>
      {info.migrations !== null ? <span className="text-muted">· {info.migrations} migrations</span> : null}
    </section>
  );
}

function ProjectRow({ row: r, links, onOpen }: { row: PortfolioRow; links: Record<string, MapLink[]>; onOpen?: (id: string) => void }) {
  const open = (e: React.MouseEvent, id: string) => {
    if (!onOpen || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    onOpen(id);
  };
  const headLinks = (links[r.id] ?? []).filter((l) => l.kind !== "chat_session").slice(0, 3);
  const id = `pf-row-${r.id}`;
  return (
    <li className="pf-row" aria-labelledby={id} data-testid="portfolio-row">
      <div className="pf-row-head">
        <div className="min-w-0 flex-1">
          <Link
            id={id}
            href={`/areas?item=${encodeURIComponent(r.id)}`}
            className="block truncate font-semibold hover:underline"
            onClick={(e) => open(e, r.id)}
          >
            {r.title}
          </Link>
          <span className="block truncate text-xs text-muted" data-dynamic>
            {r.path ? `${r.path} · ` : ""}
            {r.open} open{r.counts.done ? ` · ${r.counts.done} done` : ""} · updated {fmtDate(r.updatedAt)}
          </span>
        </div>
        {headLinks.length ? (
          <span className="pf-links">
            {headLinks.map((l) => (
              <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="pf-link">
                {linkLabel(l)}
              </a>
            ))}
          </span>
        ) : null}
      </div>
      <div className="pf-lanes">
        {PORTFOLIO_LANES.map((lane) =>
          r.lanes[lane].length ? (
            <div key={lane} className="pf-lane" data-tone={LANE_TONE[lane]}>
              <h4 className="pf-lane-h">
                {MAP_BUCKET_LABELS[lane]} <span className="text-muted">{r.lanes[lane].length}</span>
              </h4>
              <ul className="pf-lane-list">
                {r.lanes[lane].slice(0, LANE_MAX).map((i) => {
                  const ls = (links[i.id] ?? []).filter((l) => l.kind !== "chat_session");
                  return (
                    <li key={i.id} className="pf-item">
                      <StatusDot status={i.status} />
                      <Link href={`/areas?item=${encodeURIComponent(i.id)}`} className="min-w-0 flex-1 truncate hover:underline" onClick={(e) => open(e, i.id)}>
                        {i.title}
                      </Link>
                      {ls[0] ? (
                        <a href={ls[0].url} target="_blank" rel="noreferrer" className="pf-link" aria-label={`${linkLabel(ls[0])} for ${i.title}`}>
                          {linkLabel(ls[0])}
                          {ls.length > 1 ? ` +${ls.length - 1}` : ""}
                        </a>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              {r.lanes[lane].length > LANE_MAX ? (
                <Link href={`/areas?item=${encodeURIComponent(r.id)}&tab=board`} className="pf-more">
                  +{r.lanes[lane].length - LANE_MAX} more
                </Link>
              ) : null}
            </div>
          ) : null,
        )}
      </div>
    </li>
  );
}

/** Paste or pick a portfolio-map.json, preview what changes (dry run), then import with one Undo. */
function ImportDialog({ onClose, onApplied }: { onClose: () => void; onApplied: (op?: UndoOp) => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const parse = (): unknown => {
    try {
      const v = JSON.parse(text) as unknown;
      setError(null);
      return v;
    } catch {
      setError("That isn't valid JSON.");
      return null;
    }
  };
  const dry = useWorkMutation((map: unknown) => api.post<ImportResult>("/api/work/import/portfolio", { map }), { onSuccess: (r) => setPreview(r) });
  const apply = useWorkMutation((map: unknown) => api.post<ImportResult>("/api/work/import/portfolio", { map, apply: true }), {
    ok: "Imported",
    onSuccess: (r) => {
      onApplied(r.op);
      onClose();
    },
  });
  const c = preview?.plan.counts;
  const changes = preview?.plan.entries.filter((e) => e.action !== "skip") ?? [];
  return (
    <Dialog
      open
      onClose={onClose}
      title="Import portfolio map"
      description="Adds the board's projects, items, links and owner asks to Areas. Nothing is deleted, moved or settled; Finance is skipped."
      size="lg"
      footer={
        <>
          <Button variant="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          {preview && c && c.create + c.update > 0 ? (
            <Button variant="primary" type="button" busy={apply.isPending} onClick={() => apply.mutate(JSON.parse(text))}>
              Import {c.create} new · {c.update} updates
            </Button>
          ) : (
            <Button
              variant="primary"
              type="button"
              busy={dry.isPending}
              disabled={!text.trim()}
              onClick={() => {
                const v = parse();
                if (v) dry.mutate(v);
              }}
            >
              Preview
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-[13px]">
          <span className="font-medium">portfolio-map.json</span>
          <input
            type="file"
            accept="application/json,.json"
            aria-label="Choose a portfolio-map.json file"
            className="text-[13px]"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setText(await f.text());
              setPreview(null);
            }}
          />
        </label>
        <label className="flex flex-col gap-1 text-[13px]">
          <span className="font-medium">Or paste the JSON</span>
          <textarea
            className="pf-json min-h-24 rounded-md border border-line bg-surface p-2 font-mono text-xs"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setPreview(null);
            }}
            spellCheck={false}
          />
        </label>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        {preview && c ? (
          <section aria-label="Import preview" data-testid="import-preview" className="flex flex-col gap-2">
            <p className="text-[13px]">
              <b>{c.create}</b> new · <b>{c.update}</b> updated · <b>{c.unchanged}</b> already in Jarvis · <b>{c.skip}</b> skipped · <b>{c.links}</b> links
              {preview.plan.skippedLinks ? ` (${preview.plan.skippedLinks} non-https links left out)` : ""}
            </p>
            {preview.plan.notes.map((n) => (
              <p key={n} className="text-xs text-muted">
                {n}
              </p>
            ))}
            {changes.length ? (
              <ul className="pf-plan">
                {changes.slice(0, 80).map((e) => (
                  <li key={e.key}>
                    <span className="pf-plan-act" data-act={e.action}>
                      {e.action === "create" ? "New" : "Update"}
                    </span>{" "}
                    <span className="font-medium">{e.title}</span> <span className="text-muted">in {e.parentPath || "—"}</span>
                    {e.links.length ? <span className="text-muted"> · +{e.links.length} links</span> : null}
                    {e.tags.length && e.action === "update" ? <span className="text-muted"> · +{e.tags.join(", ")}</span> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-muted">Everything on the board is already in Jarvis.</p>
            )}
          </section>
        ) : null}
      </div>
    </Dialog>
  );
}
