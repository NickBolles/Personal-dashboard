"use client";

import { cx } from "@/components/ui";
import { setComposerJarvis, type ComposerTargetState } from "./useComposerTarget";

/**
 * "✦ momentumchief · Momentum bets": who the global composer asks. Inside an area it is a toggle,
 * so the owner can ask plain Jarvis instead (and back). Outside Areas it is a quiet "Jarvis" label.
 */
export function ComposerTargetChip({ target, className }: { target: ComposerTargetState; className?: string }) {
  if (!target.available)
    return (
      <span className={cx("chip shrink-0", className)} data-testid="composer-target" data-agent="Jarvis">
        <span aria-hidden="true">✦</span> Jarvis
      </span>
    );
  const area = target.node?.title ?? "";
  const label = target.switchedToJarvis ? `Asking Jarvis. Switch to ${area}'s agent` : `Asking ${target.agent} in ${area}. Switch to Jarvis`;
  return (
    <button
      type="button"
      className={cx("chip max-w-[16rem] shrink-0 cursor-pointer hover:border-line-strong", className)}
      data-tone={target.routed ? "accent" : undefined}
      data-testid="composer-target"
      data-agent={target.agent}
      data-routed={target.routed ? "1" : "0"}
      aria-pressed={!target.switchedToJarvis}
      aria-label={label}
      title={label}
      onClick={() => setComposerJarvis(!target.switchedToJarvis)}
    >
      <span aria-hidden="true">✦</span>
      <span className="truncate font-semibold">{target.switchedToJarvis ? "Jarvis" : target.agent}</span>
      {!target.switchedToJarvis ? <span className="hidden truncate text-muted sm:inline">· {area}</span> : null}
    </button>
  );
}
