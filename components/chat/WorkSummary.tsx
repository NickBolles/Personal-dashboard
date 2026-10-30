"use client";

import { useState, type ReactNode } from "react";
import { cx } from "@/components/ui";
import { ChevronIcon } from "@/components/icons";

/** One tool/subagent step, reduced to what the summary line needs. */
export type StepLike = { tool?: string; kind?: string; error?: boolean; done?: boolean };

const VERBS: { test: RegExp; one: string; many: string; verb: string }[] = [
  { test: /search|grep|find|lookup|query/i, verb: "searched", one: "source", many: "sources" },
  { test: /terminal|shell|exec|command|bash|run|process|code/i, verb: "ran", one: "command", many: "commands" },
  { test: /read|view|open|cat|list/i, verb: "read", one: "file", many: "files" },
  { test: /write|patch|edit|create|update|delete|save/i, verb: "edited", one: "file", many: "files" },
  { test: /web|browser|fetch|extract|http|url/i, verb: "browsed", one: "page", many: "pages" },
];

/** "searched 2 sources, ran 3 commands, read 4 files" — order of first appearance. */
export function summarizeSteps(steps: StepLike[]): string {
  const counts = new Map<string, { n: number; one: string; many: string; verb: string }>();
  for (const s of steps) {
    if (s.kind === "commentary") continue;
    const name = s.kind === "subagent" ? "subagent" : (s.tool ?? "");
    const hit =
      s.kind === "subagent"
        ? { verb: "delegated", one: "task", many: "tasks" }
        : (VERBS.find((v) => v.test.test(name)) ?? { verb: "used", one: "tool", many: "tools" });
    const key = `${hit.verb}:${hit.one}`;
    const c = counts.get(key) ?? { n: 0, ...hit };
    c.n++;
    counts.set(key, c);
  }
  return [...counts.values()].map((c) => `${c.verb} ${c.n} ${c.n === 1 ? c.one : c.many}`).join(", ");
}

export function formatWorked(sec?: number): string {
  if (sec === undefined || !Number.isFinite(sec) || sec < 0) return "Worked";
  if (sec < 60) return `Worked for ${Math.max(1, Math.round(sec))}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `Worked for ${m}m${s ? ` ${s}s` : ""}`;
}

/** Per-step duration: "<1s", "4s", "2m 5s". */
export function formatStepSec(sec: number): string {
  if (!Number.isFinite(sec) || sec < 1) return "<1s";
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m${s ? ` ${s}s` : ""}`;
}

const KEY = "jarvis:work-open:";
function readOpen(id: string): boolean | null {
  try {
    const v = sessionStorage.getItem(KEY + id);
    return v === null ? null : v === "1";
  } catch {
    return null;
  }
}

/**
 * The collapsed "✦ Worked for 14s · ran 3 commands" line for one assistant turn's
 * tool use. Expands to the step list (children). Failed steps passed as `alwaysShown`
 * stay visible while collapsed. Expand state is remembered per message (session).
 */
export function WorkSummary({
  id,
  steps,
  seconds,
  live,
  defaultOpen = false,
  alwaysShown,
  children,
}: {
  id: string;
  steps: StepLike[];
  seconds?: number;
  live?: boolean;
  defaultOpen?: boolean;
  alwaysShown?: ReactNode;
  children: ReactNode;
}) {
  const [choice, setChoice] = useState<boolean | null>(() => (typeof window === "undefined" ? null : readOpen(id)));
  const open = choice ?? defaultOpen;
  // Announce the finished summary once (when a live run settles), never on every streamed step.
  const [wasLive, setWasLive] = useState(!!live);
  const [announce, setAnnounce] = useState(false);
  if (wasLive && !live) {
    setWasLive(false);
    setAnnounce(true);
  }
  const failed = steps.filter((s) => s.error).length;
  const what = summarizeSteps(steps);
  const head = live ? "Working" : formatWorked(seconds);
  const label = `${head}${what ? ` · ${what}` : ""}${failed ? ` · ${failed} failed` : ""}`;
  const toggle = () => {
    const next = !open;
    setChoice(next);
    try {
      sessionStorage.setItem(KEY + id, next ? "1" : "0");
    } catch {
      /* private mode */
    }
  };
  return (
    <div className="chat-work" data-live={live || undefined}>
      <button type="button" className="chat-work-head" aria-expanded={open} onClick={toggle}>
        <span aria-hidden="true" className="chat-work-mark">
          ✦
        </span>
        <span className={cx("min-w-0 flex-1 truncate", live && "chat-work-shimmer")} data-dynamic>
          {label}
        </span>
        {failed ? <span className="sr-only">Includes a failed step.</span> : null}
        <ChevronIcon className={cx("h-4 w-4 shrink-0 transition-transform", open && "rotate-90")} />
      </button>
      <span className="sr-only" role="status">
        {announce ? label : ""}
      </span>
      {open ? <ul className="chat-work-steps">{children}</ul> : alwaysShown ? <ul className="chat-work-steps">{alwaysShown}</ul> : null}
    </div>
  );
}
