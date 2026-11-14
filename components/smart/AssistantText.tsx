"use client";

import { createContext, useContext, useMemo } from "react";
import { decisionRefOf } from "@/lib/jarvis-ui/live";
import { LiveDecision } from "./live";
import { useQuery } from "@tanstack/react-query";
import { Markdown } from "@/components/markdown/Markdown";
import { api } from "@/lib/client/api";
import { hasBlock, splitBlocks, type Segment } from "@/lib/jarvis-ui/parser";
import { validateBlock } from "@/lib/jarvis-ui/validator";
import type { SmartSettings } from "@/lib/jarvis-ui/types";
import { SmartSurface } from "./SmartSurface";
import { hideCaptureBlocks } from "@/lib/workflows/runs";

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
export function AssistantText({ text: raw, live = false }: { text: string; live?: boolean }) {
  const text = useMemo(() => hideCaptureBlocks(raw), [raw]);
  const sessionId = useContext(SmartSession);
  const liveDecision = useContext(LiveDecision);
  const block = hasBlock(text);
  const settings = useSmartSettings();
  const segments = useMemo(() => (block ? splitBlocks(text) : []), [block, text]);
  if (!block) return <Markdown text={text} className="select-text" />;
  // A decision card about one of the owner's D-n decisions is that decision: draw the live block (answer + Undo)
  // where it can be drawn, instead of a card whose options record nothing. It isn't a smart surface, so it is drawn
  // even with Smart replies off.
  const liveBlock = (s: Segment, key: number) => {
    if (!liveDecision || s.kind !== "block" || !s.closed || s.tooLarge || live) return null;
    const v = validateBlock(s.raw);
    const root = v.ok ? v.spec.elements[v.spec.root] : undefined;
    const ref = root?.type === "DecisionCard" ? decisionRefOf((root.props as { title?: string }).title) : null;
    const node = ref ? liveDecision(ref) : null;
    return node ? (
      <div key={key} className="my-2" data-live-decision={ref} data-testid="smart-live-decision">
        {node}
      </div>
    ) : null;
  };
  if (!settings.data?.enabled || !sessionId) {
    const drawn = segments.map((s, i) => (s.kind === "text" ? <Markdown key={i} text={s.text} className="select-text" /> : liveBlock(s, i)));
    return (
      <>
        {drawn}
        {segments.some((s, i) => s.kind === "block" && !drawn[i]) ? (
          <p className="mt-1 text-xs text-muted">This reply has an interactive part. Turn on Smart replies in Settings to use it.</p>
        ) : null}
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
        return liveBlock(s, i) ?? <SmartSurface key={i} spec={v.spec} sessionId={sessionId} blockIndex={s.index} dropped={v.dropped} />;
      })}
    </>
  );
}
