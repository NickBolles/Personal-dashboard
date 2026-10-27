"use client";

import { Markdown, safeHref } from "@/components/markdown/Markdown";

/**
 * AI report bodies (spec §8.6). Now a thin wrapper over the shared safe
 * renderer, so reports, chat and handoffs share one Markdown dialect and one
 * typography (`.md` in globals.css).
 */
export { safeHref };

export function SafeMarkdown({ text, sourceCount = 0, className }: { text: string; sourceCount?: number; className?: string }) {
  return <Markdown text={text} sourceCount={sourceCount} className={className ?? "ai-md"} />;
}
