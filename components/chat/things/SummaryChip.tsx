"use client";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { BrainIcon, CompassIcon, ForkIcon, PanelIcon, WorkIcon, InboxIcon } from "@/components/icons";
import type { ThingsTab } from "@/lib/chat/things";
const icons = {
  Links: CompassIcon,
  Artifacts: PanelIcon,
  PRs: ForkIcon,
  Running: BrainIcon,
  Files: InboxIcon,
  Context: CompassIcon,
  Outline: WorkIcon,
  Form: WorkIcon,
  Notes: WorkIcon,
  Outputs: PanelIcon,
};
export function ThingIcon({ kind, spinning = false }: { kind: ThingsTab; spinning?: boolean }) {
  const Icon = icons[kind];
  return <Icon className={`h-3.5 w-3.5 shrink-0 ${spinning ? "motion-safe:animate-spin" : ""}`} />;
}
export function SummaryChip({
  kind,
  count,
  dot,
  tone = "neutral",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { kind: ThingsTab; count?: number | null; dot?: "red" | "yellow" | null; tone?: string; children?: ReactNode }) {
  return (
    <button
      type="button"
      {...props}
      aria-label={
        props["aria-label"] ??
        `${typeof children === "string" ? children : kind}${count === undefined ? "" : count === null ? " unavailable" : ` ${count}${kind === "Context" ? "%" : ""}`}`
      }
      className={`chat-summary-chip min-h-11 sm:min-h-10 dense:min-h-8 ${props.className ?? ""}`}
      data-tone={tone}
    >
      <ThingIcon kind={kind} spinning={kind === "Running" && count != null && count > 0} />
      {dot ? <span className="chat-attention-dot" data-dot={dot} aria-label={dot === "red" ? "Something failed" : "Worth a look"} /> : null}
      <span>{children ?? kind}</span>
      {count !== undefined ? (
        <span className="tabular-nums">
          {" "}
          {count ?? "—"}
          {kind === "Context" && count != null ? "%" : ""}
        </span>
      ) : null}
    </button>
  );
}
