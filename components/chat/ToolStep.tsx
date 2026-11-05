"use client";
import { memo, useState } from "react";
import { BrainIcon, ToolIcon, SearchIcon, WorkIcon, CompassIcon, ChevronIcon } from "@/components/icons";
import { presentTool, redactToolText, toolResultState, type ToolKind } from "@/lib/tool-presentation";
import { cx } from "@/components/ui";
import { toolOutcome } from "@/lib/tool-outcome";
const ICONS = { agent: BrainIcon, tool: ToolIcon, search: SearchIcon, file: WorkIcon, web: CompassIcon, jarvis: WorkIcon };
function StepIcon({ kind }: { kind: ToolKind }) {
  if (kind === "terminal")
    return (
      <span aria-hidden className="shrink-0 font-mono text-sm">
        ›_
      </span>
    );
  const Icon = ICONS[kind];
  return <Icon className="h-4 w-4 shrink-0" />;
}
/** Shared by live activity and the persisted transcript; raw payloads are secondary. */
export const ToolStep = memo(function ToolStep({
  id,
  tool,
  input,
  output,
  done = true,
  error,
  duration,
}: {
  id?: string;
  tool: string;
  input?: string;
  output?: string;
  done?: boolean;
  error?: boolean;
  duration?: string;
}) {
  const [open, setOpen] = useState(() => {
    try {
      return !!id && sessionStorage.getItem(`jarvis:tool-open:${id}`) === "1";
    } catch {
      return false;
    }
  });
  const toggle = () => {
    setOpen(!open);
    try {
      if (id) sessionStorage.setItem(`jarvis:tool-open:${id}`, open ? "0" : "1");
    } catch {
      /* storage unavailable */
    }
  };
  const info = presentTool(tool, input);
  const status = toolResultState(output, error, done);
  const outcome = done && status !== "failed" ? toolOutcome(info.children.length === 1 ? info.children[0].name : tool, output) : undefined;
  return (
    <li>
      <button type="button" className={cx("chat-tool", status === "failed" && "text-danger")} aria-expanded={open} onClick={toggle}>
        <StepIcon kind={info.kind} />
        <span className="min-w-0 flex-1 break-words">
          {outcome?.label ?? info.label}
          {info.target ? ` · ${info.target}` : ""}
        </span>
        <span className="shrink-0 text-xs text-muted" data-dynamic>
          {duration ? `${duration} · ` : ""}
          {status}
        </span>
        <ChevronIcon className={cx("h-4 w-4 shrink-0", open && "rotate-90")} />
      </button>
      {outcome ? (
        <p className="ml-9 text-xs text-muted">
          {outcome.href ? (
            <a href={outcome.href} className="text-accent underline">
              Open item
            </a>
          ) : null}
          {outcome.status ? ` · ${outcome.status}` : ""}
        </p>
      ) : null}
      {open ? (
        <div className="ml-5 mt-1 min-w-0 rounded-lg border border-line bg-surface-2 p-2 text-xs">
          <p className="break-all text-muted">
            Tool: <code>{tool}</code>
          </p>
          {info.children.length ? (
            <ul className="mt-1 space-y-1" aria-label="Wrapped tool requests">
              {info.children.map((c, i) => (
                <li key={i} className="flex min-w-0 gap-2">
                  <StepIcon kind={c.kind} />
                  <span className="min-w-0 break-words">
                    {c.label}
                    {c.target ? ` · ${c.target}` : ""}
                    <code className="block break-all text-muted">{c.name}</code>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          <details className="mt-2">
            <summary className="cursor-pointer">Arguments and output</summary>
            {input ? <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words">{redactToolText(input)}</pre> : null}
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words">
              {output ? redactToolText(output) : done ? "No output available" : "Waiting for output"}
            </pre>
          </details>
        </div>
      ) : null}
    </li>
  );
});
