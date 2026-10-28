"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";

/** Friendly names for server-resolved context refs (server/smart/context.ts CTX_LABELS). */
const LABELS: Record<string, string> = {
  "@ctx:overdue_todos": "Overdue tasks",
  "@ctx:morning_brief": "Morning brief",
  "@ctx:week_plan": "This week's plan",
};

/**
 * "Attached context" above a new chat. `@ctx:` refs are resolved on the
 * server when the message is sent, so here they show as a chip with a live
 * count ("Overdue tasks (12)"), never as the raw ref.
 */
export function ContextNote({ context }: { context: string }) {
  const lines = context.split("\n");
  const refs = lines.map((l) => l.trim()).filter((l) => l in LABELS);
  const counts = useQuery({
    queryKey: ["smart", "context-refs"],
    queryFn: () => api.get<{ counts: Record<string, number> }>("/api/smart/context-refs"),
    enabled: refs.length > 0,
    staleTime: 60_000,
  });
  const text = lines
    .filter((l) => !(l.trim() in LABELS))
    .join("\n")
    .trim();
  return (
    <div className="mb-2 rounded-[10px] border border-line bg-surface-2 px-3 py-2 text-sm" data-testid="attached-context">
      <p className="eyebrow">Attached context</p>
      {refs.length ? (
        <p className="mt-1 flex flex-wrap gap-1.5">
          {refs.map((r) => {
            const n = counts.data?.counts[r];
            return (
              <span key={r} className="chip" data-context-ref={r}>
                {LABELS[r]}
                {n != null ? ` (${n})` : ""}
              </span>
            );
          })}
        </p>
      ) : null}
      {text ? <p className="mt-0.5 whitespace-pre-line">{text}</p> : null}
    </div>
  );
}
