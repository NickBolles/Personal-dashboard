import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { JSONUIProvider, Renderer } from "@json-render/react";
import type { Spec } from "@json-render/core";
import { validateBlock } from "@/lib/jarvis-ui/validator";
import { registry } from "@/components/smart/registry";
import { SurfaceContext, type SurfaceCtx } from "@/components/smart/context";

const FIX = path.join(import.meta.dirname, "fixtures/jarvis-ui");

function html(name: string, refs: SurfaceCtx["refs"] = {}) {
  const v = validateBlock(fs.readFileSync(path.join(FIX, name), "utf8"));
  if (!v.ok) throw new Error(v.reason);
  const ctx: SurfaceCtx = {
    today: "2026-10-27",
    readOnly: false,
    refs,
    hydrating: false,
    staged: new Map(),
    errors: new Map(),
    applied: new Map(),
    stage: () => undefined,
    undo: () => undefined,
    checks: [],
    toggleCheck: () => undefined,
    skips: [],
    toggleSkip: () => undefined,
    uiState: {},
    patchState: () => undefined,
  };
  return renderToStaticMarkup(
    <SurfaceContext.Provider value={ctx}>
      <JSONUIProvider registry={registry}>
        <Renderer spec={v.spec as unknown as Spec} registry={registry} />
      </JSONUIProvider>
    </SurfaceContext.Provider>,
  );
}

describe("smart renderer (web)", () => {
  it("escapes model text: no HTML, scripts or javascript: links", () => {
    const out = html("xss.json");
    expect(out).not.toMatch(/<img|<script|<b>|href="javascript/i);
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(out).toContain("<strong>&lt;script&gt;alert(2)&lt;/script&gt;</strong>");
  });

  it("renders triage rows from hydrated titles, never from the spec", () => {
    const out = html("overdue-triage.json", {
      "todo:gt-1": { ref: "todo:gt-1", kind: "todo", title: "Return ladder", due: "2026-10-01", status: "open" },
      "todo:gt-2": { ref: "todo:gt-2", kind: "todo", title: "Pick up frame", due: "2026-10-20", status: "open" },
      "todo:gt-3": { ref: "todo:gt-3", unavailable: "finance" },
    });
    expect(out).toContain("Return ladder");
    expect(out).toContain("26 days late");
    expect(out).toContain("Finance is never shown to AI");
    expect(out).toContain('aria-label="This week (Fri, Oct 30): Return ladder"');
  });

  it("renders decision, checklist and gauge accessibly", () => {
    const out = html("decision-checklist-gauge.json");
    expect(out).toContain('role="radiogroup"');
    expect(out).toContain('role="meter"');
    expect(out).toContain('type="checkbox"');
    expect(out).toContain("Ticking records a step; it never runs it.");
  });

  it("renders brief chips, metric gauges, the week grid and a PR card from hydrated data only", () => {
    const out = html("workflows-v11.json", {
      "todo:gt-1": { ref: "todo:gt-1", kind: "todo", title: "Return ladder", due: "2026-10-26", status: "open" },
      "item:wi_1": { ref: "item:wi_1", kind: "item", title: "Team totals", due: "2026-10-27", status: "in_progress", where: "Momentum" },
      "metric:ai_spend_today": { ref: "metric:ai_spend_today", kind: "metric", label: "AI today", value: 0.62, max: 5, unit: "usd", note: "household budget" },
      "metric:ai_spend_7d": {
        ref: "metric:ai_spend_7d",
        kind: "metric",
        label: "AI spend · 7 d",
        value: 1.5,
        unit: "usd",
        note: "ledger",
        series: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ label: `d${n}`, value: n / 10 })),
      },
      "cal:week:2026-10-26:5": {
        ref: "cal:week:2026-10-26:5",
        kind: "calendar",
        writable: false,
        events: [{ id: "e1", title: "Dentist", day: "2026-10-28", start: "13:00", end: "14:30", allDay: false }],
      },
      "pr:NickBolles/jarvis#7": {
        ref: "pr:NickBolles/jarvis#7",
        kind: "pr",
        title: "Grading on V5",
        repo: "NickBolles/jarvis",
        number: 7,
        state: "open",
        draft: false,
        url: "https://github.com/NickBolles/jarvis/pull/7",
        checks: [
          { name: "typecheck", state: "pass" },
          { name: "e2e", state: "fail" },
        ],
        reviews: [{ who: "nick", state: "approved" }],
        mergeable: true,
        codexFindings: 1,
        readiness: { done: 3, total: 4, blockers: ["1 failing check"] },
      },
    });
    expect(out).toContain("$0.62");
    expect(out).toContain('aria-valuetext="$0.62 of $5.00"');
    expect(out).toContain('aria-label="Today: Return ladder"');
    expect(out).toContain('aria-label="Skip: Team totals"');
    // "Today" is a no-op for something already due today.
    expect(out).toMatch(/disabled="" title="Already due today" aria-label="Today: Team totals"/);
    expect(out).toContain("Dentist");
    expect(out).toContain("Unscheduled (1)");
    expect(out).toContain("Merge readiness 3/4");
    expect(out).toContain("Open on GitHub to merge ↗");
    expect(out).not.toMatch(/>\s*Merge\s*</);
    expect(out).toContain('href="https://github.com/NickBolles/jarvis/pull/7"');
  });
});
