"use client";

import { FilesSection } from "./Attachments";

import { useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { extractLinks } from "@/lib/chat-links";
import type { TimelineItem } from "@/lib/hermes";
import type { PanelLink } from "@/server/chat/links";
import { Badge, Button, cx } from "@/components/ui";
import type { ContextChip } from "./ContextSheet";

export function usePanelLinks(sessionId: string, timeline: TimelineItem[], readOnly: boolean) {
  const qc = useQueryClient();
  const key = ["chat-links", sessionId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ links: PanelLink[] }>(`/api/hermes/sessions/${encodeURIComponent(sessionId)}/links-panel`),
    staleTime: 15_000,
  });
  const seen = useMemo(() => extractLinks(timeline), [timeline]);
  const sent = useRef(new Set<string>());
  useEffect(() => {
    if (readOnly) return;
    // The route caps URLs at 2048 chars; one oversized URL would reject the whole batch.
    const fresh = seen.filter((l) => l.url.length <= 2048 && !sent.current.has(l.url));
    if (!fresh.length) return;
    const t = setTimeout(() => {
      for (const l of fresh) sent.current.add(l.url);
      api
        .post<{ links: PanelLink[] }>(`/api/hermes/sessions/${encodeURIComponent(sessionId)}/links-panel`, {
          links: fresh.map(({ url, kind, domain, source, firstSeenAt }) => ({ url, kind, domain, source, firstSeenAt })),
        })
        .then((r) => qc.setQueryData(["chat-links", sessionId], r))
        .catch(() => {
          for (const l of fresh) sent.current.delete(l.url);
        });
    }, 600);
    return () => clearTimeout(t);
  }, [seen, sessionId, readOnly, qc]);
  const patch = useMutation({
    mutationFn: (b: { url: string; pinned?: boolean; removed?: boolean }) =>
      api.patch<{ links: PanelLink[] }>(`/api/hermes/sessions/${encodeURIComponent(sessionId)}/links-panel`, b),
    onSuccess: (r) => qc.setQueryData(key, r),
  });
  return { links: q.data?.links ?? [], patch: (b: { url: string; pinned?: boolean; removed?: boolean }) => patch.mutate(b) };
}

/** Attached context / Files / Links for one conversation. */
export function LinksPanel({
  sessionId,
  links,
  context,
  readOnly,
  onPatch,
  onRemoveContext,
}: {
  sessionId: string;
  links: PanelLink[];
  context: ContextChip[];
  readOnly: boolean;
  onPatch: (b: { url: string; pinned?: boolean; removed?: boolean }) => void;
  onRemoveContext: (ref: string) => void;
}) {
  return (
    <div className="space-y-4 text-sm" data-testid="links-panel">
      <section aria-labelledby="lp-ctx">
        <h3 id="lp-ctx" className="mb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
          Attached context
        </h3>
        {context.length ? (
          <ul className="flex flex-wrap gap-1">
            {context.map((c) => (
              <li key={c.ref}>
                <button type="button" className="chip cursor-pointer" onClick={() => onRemoveContext(c.ref)} aria-label={`Remove context ${c.label}`}>
                  {c.label} ✕
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted">Nothing attached to the next message. Use + to add context.</p>
        )}
      </section>
      <FilesSection sessionId={sessionId} />
      <section aria-labelledby="lp-links">
        <h3 id="lp-links" className="mb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
          Links{links.length ? ` (${links.length})` : ""}
        </h3>
        {links.length ? (
          <ul className="space-y-1.5">
            {links.map((l) => (
              <li key={l.url} className={cx("rounded-lg border border-line p-2", l.pinned && "border-accent/50")} data-kind={l.kind}>
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium" title={l.title}>
                      {l.kind === "github" && l.number ? <span className="text-muted">#{l.number} </span> : null}
                      {l.title}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {l.kind === "artifact" ? `Artifact · ${l.slug}` : l.kind === "github" ? `${l.repo} · ${l.ghType === "pull" ? "PR" : "Issue"}` : l.domain}
                    </p>
                  </div>
                  {l.kind === "github" && l.state ? (
                    <Badge tone={l.state === "open" ? "ok" : l.state === "merged" ? "accent" : undefined}>{l.state}</Badge>
                  ) : null}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <a href={l.url} target="_blank" rel="noopener noreferrer" className="chip hover:border-line-strong" aria-label={`Open ${l.title}`}>
                    Open ↗
                  </a>
                  {readOnly ? null : (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onPatch({ url: l.url, pinned: !l.pinned })}
                        aria-pressed={l.pinned}
                        aria-label={`${l.pinned ? "Unpin" : "Pin"} ${l.title}`}
                      >
                        {l.pinned ? "Unpin" : "Pin"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => onPatch({ url: l.url, removed: true })} aria-label={`Remove ${l.title}`}>
                        Remove
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted">Links shared in this chat (artifacts, PRs, pages) collect here.</p>
        )}
      </section>
    </div>
  );
}
