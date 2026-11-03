"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";

/**
 * #142 Verse text for a Scripture reference from the offline WEB pack on this
 * Jarvis (no third-party lookups). Renders nothing extra until the owner has
 * downloaded the pack; then a collapsed quote with the translation label.
 */
export type BibleStatus = { installed: boolean; translation: string; name: string; version: string };
type Passage = { ref: string; translation: string; verses: { chapter: number; verse: number; text: string }[]; truncated: boolean; attribution: string };

export function useBibleStatus() {
  return useQuery({ queryKey: ["bible-status"], queryFn: () => api.get<BibleStatus>("/api/bible"), staleTime: 5 * 60_000 });
}

export function PassageText({ reference, compact = false }: { reference: string; compact?: boolean }) {
  const status = useBibleStatus();
  const installed = status.data?.installed ?? false;
  const q = useQuery({
    queryKey: ["bible-passage", reference],
    queryFn: () => api.get<Passage>(`/api/bible/passage?ref=${encodeURIComponent(reference)}`),
    enabled: installed && Boolean(reference.trim()),
    staleTime: Infinity,
    retry: false,
  });
  const [open, setOpen] = useState(false);
  if (!installed || !reference.trim()) return null;
  if (q.isLoading) return <p className="text-xs text-muted">Loading verse text…</p>;
  if (q.isError || !q.data?.verses.length) return null;
  const multiChapter = new Set(q.data.verses.map((v) => v.chapter)).size > 1;
  const long = q.data.verses.length > 4;
  return (
    <figure className="mt-1 min-w-0" data-testid="scripture-passage">
      <blockquote className={`break-words text-sm leading-relaxed ${long && !open ? "line-clamp-4" : ""}`} cite={`WEB ${q.data.ref}`}>
        {q.data.verses.map((v) => (
          <span key={`${v.chapter}:${v.verse}`}>
            <sup className="mr-0.5 text-[0.7em] text-muted">{multiChapter ? `${v.chapter}:${v.verse}` : v.verse}</sup>
            {v.text}{" "}
          </span>
        ))}
      </blockquote>
      <figcaption className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
        <span title={q.data.attribution}>
          {q.data.translation} · {compact ? "public domain" : "World English Bible, public domain"}
        </span>
        {long ? (
          <button type="button" className="tap underline" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Show less" : "Show full passage"}
          </button>
        ) : null}
        {q.data.truncated ? <span>First 200 verses</span> : null}
      </figcaption>
    </figure>
  );
}
