"use client";

import { createContext, useContext, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Markdown } from "@/components/markdown/Markdown";
import { api } from "@/lib/client/api";
import { hasBlock, splitBlocks } from "@/lib/jarvis-ui/parser";
import { validateBlock } from "@/lib/jarvis-ui/validator";
import type { SmartSettings } from "@/lib/jarvis-ui/types";
import { answerQuestions } from "@/lib/jarvis-ui/answers";
import { SmartSurface } from "./SmartSurface";
import { AnswerBatch, BatchedAnswers } from "./AnswerBatch";
import { hideCaptureBlocks } from "@/lib/workflows/runs";

export const SmartSession = createContext<string | null>(null);
export function useSmartSettings(enabled = true) {
  return useQuery({ queryKey: ["smart-settings"], queryFn: () => api.get<SmartSettings>("/api/smart/settings"), staleTime: 5 * 60_000, enabled });
}

/** One response is one answer batch, across nested cards and fences. Streaming never exposes incomplete controls. */
export function AssistantText({ text: raw, live = false }: { text: string; live?: boolean }) {
  const text = useMemo(() => hideCaptureBlocks(raw), [raw]);
  const sessionId = useContext(SmartSession);
  const block = hasBlock(text);
  const settings = useSmartSettings();
  const segments = useMemo(() => (block ? splitBlocks(text) : []), [block, text]);
  const parsed = useMemo(() => segments.map((s) => (s.kind === "block" && s.closed && !s.tooLarge ? validateBlock(s.raw) : null)), [segments]);
  if (!block) return <Markdown text={text} className="select-text" />;
  if (!settings.data?.enabled || !sessionId)
    return (
      <>
        {segments.map((s, i) => (s.kind === "text" ? <Markdown key={i} text={s.text} className="select-text" /> : null))}
        <p className="mt-1 text-xs text-muted">This reply has an interactive part. Turn on Smart replies in Settings to use it.</p>
      </>
    );
  const questions = parsed.flatMap((v, i) => (v?.ok ? answerQuestions(v.spec, i) : []));
  return (
    <BatchedAnswers.Provider value={true}>
      {segments.map((s, i) => {
        if (s.kind === "text") return <Markdown key={i} text={s.text} className="select-text" />;
        if (!s.closed || live)
          return (
            <p key={i} className="my-2 text-xs text-muted" data-testid="smart-preparing">
              Preparing an interactive reply…
            </p>
          );
        const v = parsed[i];
        if (!v?.ok)
          return (
            <p key={i} className="my-2 text-xs text-muted" data-testid="smart-fallback">
              Some content couldn’t be shown. Unsupported controls cannot be used; ask for a corrected reply.
            </p>
          );
        const qs = answerQuestions(v.spec, i);
        // Pure answer blocks do not need a smart-surface server record or a repeated change tray/header.
        const answerOnly =
          qs.length &&
          Object.values(v.spec.elements).every((e) => ["Stack", "Section", "DecisionCard", "Form"].includes(e.type)) &&
          Object.values(v.spec.elements).filter((e) => e.type === "DecisionCard" || e.type === "Form").length ===
            new Set(qs.map((q) => q.id.split(":").slice(0, 2).join(":"))).size;
        return answerOnly ? null : <SmartSurface key={i} spec={v.spec} sessionId={sessionId} blockIndex={s.index} dropped={v.dropped} />;
      })}
      {!live && questions.length ? <AnswerBatch key={`${sessionId}:${text}`} questions={questions} session={sessionId} source={text} /> : null}
    </BatchedAnswers.Provider>
  );
}
