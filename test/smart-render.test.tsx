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
});
