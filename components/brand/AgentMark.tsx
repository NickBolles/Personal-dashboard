import type { CSSProperties } from "react";

const HUES: Record<string, string> = {
  chiefofstaff: "var(--agent-chiefofstaff)",
  momentumchief: "var(--agent-momentumchief)",
  devchief: "var(--agent-devchief)",
  homelabchief: "var(--agent-homelabchief)",
};

/** Ring colour for an agent/profile name; unknown agents use the AI violet. */
export function agentHue(name?: string | null) {
  const key = (name ?? "").toLowerCase().replace(/[^a-z]/g, "");
  return HUES[key] ?? "var(--ai)";
}

/**
 * Agent identity mark: initial inside a hue ring (per-agent `--agent-*`
 * token), optional `busy` arc while the agent is working. Decorative unless
 * `label` is given.
 */
export function AgentMark({
  name,
  size = 18,
  busy,
  label,
  className,
}: {
  name?: string | null;
  size?: 18 | 28;
  busy?: boolean;
  label?: string;
  className?: string;
}) {
  const initial = (name ?? "").replace(/^@/, "").charAt(0) || "J";
  return (
    <span
      className={["agent-mark", className].filter(Boolean).join(" ")}
      data-size={size}
      data-busy={busy || undefined}
      style={{ "--am": agentHue(name) } as CSSProperties}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {initial}
    </span>
  );
}
