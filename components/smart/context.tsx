"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Intent } from "@/lib/jarvis-ui/intents";
import type { AppliedEntry, HydratedRef } from "@/lib/jarvis-ui/types";

/** Everything a catalog component needs from its surface (tray, live data, applied state). */
export type SurfaceCtx = {
  surfaceId?: string;
  today: string;
  readOnly: boolean;
  refs: Record<string, HydratedRef>;
  hydrating: boolean;
  /** staged intents by target ref */
  staged: Map<string, Intent>;
  errors: Map<string, string>;
  /** last live (not undone) applied entry by target ref */
  applied: Map<string, AppliedEntry>;
  stage: (target: string, intent: Intent | undefined) => void;
  undo: (entry: AppliedEntry) => void;
  undoing?: string;
  checks: string[];
  toggleCheck: (id: string) => void;
  /** brief rows skipped on this surface (no write) */
  skips: string[];
  toggleSkip: (ref: string) => void;
  /** the surface's saved UI state (e.g. week-plan block positions) */
  uiState: Record<string, unknown>;
  patchState: (patch: Record<string, unknown>) => void;
};

export const SurfaceContext = createContext<SurfaceCtx | null>(null);

export function useSurface() {
  const c = useContext(SurfaceContext);
  if (!c) throw new Error("SurfaceContext missing");
  return c;
}

/** Plain text with **bold** and `code` only; never HTML. */
export function InlineText({ text }: { text: string }): ReactNode {
  const parts = text.split(/(\*\*[^*\n]{1,400}\*\*|`[^`\n]{1,200}`)/g);
  return parts.map((p, i) =>
    p.startsWith("**") && p.endsWith("**") && p.length > 4 ? (
      <strong key={i}>{p.slice(2, -2)}</strong>
    ) : p.startsWith("`") && p.endsWith("`") && p.length > 2 ? (
      <code key={i}>{p.slice(1, -1)}</code>
    ) : (
      p
    ),
  );
}
