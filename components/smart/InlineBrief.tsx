"use client";
import { lazy, Suspense, useState } from "react";
import { Button } from "@/components/ui/legacy";
const Brief = lazy(() => import("./WorkflowSurface").then((m) => ({ default: m.WorkflowSurface })));
/** Same period surface as /areas/brief; phones initially show the first section. */
export function InlineBrief() {
  const [all, setAll] = useState(false);
  return (
    <section className="smart-inline-brief" data-collapsed={!all} aria-label="Morning brief" data-testid="today-brief">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">☀ Morning brief</h3>
        <Button data-brief-expand size="sm" variant="ghost" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? "Show less" : "Show all"}
        </Button>
      </header>
      <Suspense fallback={<p className="text-xs text-muted">Loading brief…</p>}>
        <Brief kind="brief" compact />
      </Suspense>
    </section>
  );
}
