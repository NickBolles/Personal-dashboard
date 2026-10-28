"use client";

import { createContext, useContext, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Markdown } from "@/components/markdown/Markdown";
import { api } from "@/lib/client/api";
import { hasBlock, splitBlocks } from "@/lib/jarvis-ui/parser";
import { validateBlock } from "@/lib/jarvis-ui/validator";
import type { SmartSettings } from "@/lib/jarvis-ui/types";
import { SmartSurface } from "./SmartSurface";

/** The Hermes session the assistant text belongs to (provided by the conversation view). */
export const SmartSession = createContext<string | null>(null);

export function useSmartSettings() {
  return useQuery({ queryKey: ["smart-settings"], queryFn: () => api.get<SmartSettings>("/api/smart/settings"), staleTime: 5 * 60_000 });
}

/**
 * Assistant message body. Plain markdown unless it carries ```jarvis-ui
 * blocks; then the text around them stays markdown and each valid block
 * renders as a smart surface. Invalid/unknown blocks fall back to the text
 * with a short note; with smart replies off, the reply shows its summary.
 */
export function AssistantText({ text, live = false }: { text: string; live?: boolean }) {
  const sessionId = useContext(SmartSession);
  const block = hasBlock(text);
  const settings = useSmartSettings();
  const segments = useMemo(() => (block ? splitBlocks(text) : []), [block, text]);
  if (!block) return <Markdown text={text} className="select-text" />;
  if (!settings.data?.enabled || !sessionId) {
    return (
      <>
        {segments.map((s, i) => (s.kind === "text" ? <Markdown key={i} text={s.text} className="select-text" /> : null))}
        <p className="mt-1 text-xs text-muted">This reply has an interactive part. Turn on Smart replies in Settings to use it.</p>
      </>
    );
  }
  return (
    <>
      {segments.map((s, i) => {
        if (s.kind === "text") return <Markdown key={i} text={s.text} className="select-text" />;
        if (!s.closed || live)
          return (
            <p key={i} className="my-2 text-xs text-muted" data-testid="smart-preparing">
              Preparing an interactive reply…
            </p>
          );
        const v = s.tooLarge ? ({ ok: false } as const) : validateBlock(s.raw);
        if (!v.ok)
          return (
            <p key={i} className="my-2 text-xs text-muted" data-testid="smart-fallback">
              Some content couldn’t be shown.
            </p>
          );
        return <SmartSurface key={i} spec={v.spec} sessionId={sessionId} blockIndex={s.index} dropped={v.dropped} />;
      })}
    </>
  );
}
