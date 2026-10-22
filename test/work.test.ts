import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { __setTestDatabase } from "@/server/db";
import { claimInstance, createSession, resolveUser } from "@/server/auth";
import { createPerson } from "@/server/people";
import { recentAudit } from "@/server/audit";
import { search } from "@/server/search";
import {
  buildCustomWidgetSrcdoc,
  comparatorPasses,
  CUSTOM_HTML_MAX_BYTES,
  CUSTOM_WIDGET_CSP,
  CUSTOM_WIDGET_SANDBOX,
  handoffMarkdown,
  packetSchema,
  parseGithubUrl,
  parsePrUrl,
  widgetCreateSchema,
} from "@/lib/work";
import { evaluateValidation, nextPacketVersion, onImplementationMerged, planTransition, settleGate, wouldCreateCycle } from "@/server/work/lifecycle";
import * as store from "@/server/work/store";
import { addWidget, getDashboard, updateWidget } from "@/server/work/dashboard";
import * as itemsRoute from "@/app/api/work/items/route";
import * as itemRoute from "@/app/api/work/items/[id]/route";
import * as moveRoute from "@/app/api/work/items/[id]/move/route";
import * as settleRoute from "@/app/api/work/items/[id]/settle/route";
import * as linkRoute from "@/app/api/work/links/[id]/route";
import * as refreshRoute from "@/app/api/work/links/[id]/refresh/route";
import * as widgetsRoute from "@/app/api/work/dashboard/widgets/route";

const AT = "2026-10-01T12:00:00.000Z";

describe("lifecycle (pure)", () => {
  it("merge → awaiting validation unless the packet explicitly needs none", () => {
    const base = { status: "in_review" as const, validations: [], prNumber: 42, at: AT };
    expect(onImplementationMerged({ ...base, latestPacket: { validationRequired: true } })).toMatchObject({ status: "awaiting_validation", settledKind: null });
    // No packet: validation defaults to required.
    expect(onImplementationMerged({ ...base, latestPacket: null })).toMatchObject({ status: "awaiting_validation" });
    expect(onImplementationMerged({ ...base, latestPacket: { validationRequired: false } })).toEqual({
      status: "settled",
      settledKind: "auto",
      settledReason: "PR #42 merged; no validation required",
      completedAt: AT,
      reason: "PR #42 merged; no validation required",
    });
    // Pending (or failed) validations still gate, even with "no validation required".
    expect(onImplementationMerged({ ...base, latestPacket: { validationRequired: false }, validations: [{ status: "pending" }] })).toMatchObject({
      status: "awaiting_validation",
    });
    expect(onImplementationMerged({ ...base, latestPacket: { validationRequired: false }, validations: [{ status: "fail" }] })).toMatchObject({
      status: "awaiting_validation",
    });
    expect(onImplementationMerged({ ...base, latestPacket: { validationRequired: false }, validations: [{ status: "pass" }] })).toMatchObject({
      status: "settled",
      settledKind: "auto",
    });
    // Closed work and work already waiting are left alone.
    expect(onImplementationMerged({ ...base, status: "settled", latestPacket: null })).toBeNull();
    expect(onImplementationMerged({ ...base, status: "awaiting_validation", latestPacket: null })).toBeNull();
  });

  it("evaluates validations with every comparator, and waivers need a reason", () => {
    expect(evaluateValidation({ comparator: "<=", threshold: 800, observed: 640 })).toEqual({ status: "pass", waiverReason: null });
    expect(evaluateValidation({ comparator: "<=", threshold: 800, observed: 900 })).toMatchObject({ status: "fail" });
    expect(evaluateValidation({ comparator: "<=", threshold: 800, observed: null })).toMatchObject({ status: "pending" });
    expect(evaluateValidation({ comparator: ">", threshold: 1, observed: 1, waive: true, waiverReason: "Measured elsewhere" })).toEqual({
      status: "waived",
      waiverReason: "Measured elsewhere",
    });
    expect(() => evaluateValidation({ comparator: ">", threshold: 1, observed: 1, waive: true, waiverReason: " " })).toThrow(/reason/);
    expect(comparatorPasses(">=", 5, 5)).toBe(true);
    expect(comparatorPasses("<", 5, 5)).toBe(false);
    expect(comparatorPasses(">", 6, 5)).toBe(true);
    expect(comparatorPasses("=", 0.1 + 0.2, 0.3)).toBe(true);
    expect(comparatorPasses("=", 0.31, 0.3)).toBe(false);
  });

  it("gates settlement on pass/waived validations", () => {
    expect(settleGate(null, [])).toEqual({ allowed: true, reason: null });
    expect(settleGate({ validationRequired: true }, [])).toMatchObject({ allowed: false });
    expect(settleGate({ validationRequired: false }, [])).toMatchObject({ allowed: true });
    expect(settleGate({ validationRequired: true }, [{ status: "pass" }, { status: "waived" }])).toMatchObject({ allowed: true });
    expect(settleGate({ validationRequired: true }, [{ status: "pass" }, { status: "pending" }]).reason).toMatch(/1 validation still pending/);
    expect(settleGate(null, [{ status: "fail" }]).reason).toMatch(/failed/);
    const t = { from: "awaiting_validation" as const, nextAction: "", latestPacket: { validationRequired: true }, at: AT };
    expect(() => planTransition({ ...t, to: "settled", validations: [{ status: "pending" }] })).toThrow(/pending/);
    expect(planTransition({ ...t, to: "settled", validations: [{ status: "pass" }], reason: "p95 ok" })).toEqual({
      status: "settled",
      settledKind: "manual",
      settledReason: "p95 ok",
      completedAt: AT,
    });
  });

  it("reopen needs a reason and clears settlement; ready/in progress need a next action", () => {
    const t = { from: "settled" as const, nextAction: "", latestPacket: null, validations: [], at: AT };
    expect(() => planTransition({ ...t, to: "reopened" })).toThrow(/reopening/);
    expect(planTransition({ ...t, to: "reopened", reason: "Regression" })).toEqual({
      status: "reopened",
      settledKind: null,
      settledReason: null,
      completedAt: null,
    });
    expect(() => planTransition({ ...t, to: "in_progress" })).toThrow(/next action/);
    expect(() => planTransition({ ...t, to: "ready", nextAction: "  " })).toThrow(/next action/);
    expect(planTransition({ ...t, to: "in_progress", nextAction: "Profile hydration" }).status).toBe("in_progress");
  });

  it("prevents tree cycles and versions packets monotonically", () => {
    const parents = new Map<string, string | null>([
      ["area", null],
      ["proj", "area"],
      ["v5", "proj"],
      ["bug", "v5"],
    ]);
    expect(wouldCreateCycle(parents, "proj", "bug")).toBe(true);
    expect(wouldCreateCycle(parents, "v5", "v5")).toBe(true);
    expect(wouldCreateCycle(parents, "bug", "area")).toBe(false);
    expect(wouldCreateCycle(parents, "proj", null)).toBe(false);
    expect(
      wouldCreateCycle(
        new Map([
          ["a", "b"],
          ["b", "a"],
        ]),
        "x",
        "a",
      ),
    ).toBe(true);
    expect(nextPacketVersion([])).toBe(1);
    expect(nextPacketVersion([{ version: 1 }, { version: 3 }, { version: 2 }])).toBe(4);
  });
});

describe("pure helpers", () => {
  it("parses GitHub PR and issue URLs only", () => {
    expect(parsePrUrl("https://github.com/NickBolles/momentum-bets/pull/128")).toEqual({
      owner: "NickBolles",
      repo: "momentum-bets",
      number: 128,
      kind: "pull",
      url: "https://github.com/NickBolles/momentum-bets/pull/128",
    });
    expect(parsePrUrl("https://github.com/o/r.js/pull/7/files?diff=split#x")?.number).toBe(7);
    expect(parsePrUrl("https://github.com/o/r/issues/7")).toBeNull();
    expect(parseGithubUrl("https://github.com/o/r/issues/7")?.kind).toBe("issues");
    for (const bad of [
      "http://github.com/o/r/pull/1",
      "https://gitlab.com/o/r/pull/1",
      "https://github.com/o/r/pull/0",
      "https://github.com/o/r/pull/abc",
      "not a url",
      "javascript:alert(1)",
    ])
      expect(parsePrUrl(bad)).toBeNull();
  });

  it("builds a sandbox-only srcdoc with the CSP first and a size limit", () => {
    const doc = buildCustomWidgetSrcdoc("<p id=x>Hi</p><script>document.title='t'</script>");
    expect(CUSTOM_WIDGET_SANDBOX).toBe("allow-scripts");
    expect(CUSTOM_WIDGET_SANDBOX).not.toContain("allow-same-origin");
    expect(CUSTOM_WIDGET_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:");
    const csp = doc.indexOf('http-equiv="Content-Security-Policy"');
    expect(csp).toBeGreaterThan(0);
    expect(doc).toContain(`content="${CUSTOM_WIDGET_CSP}"`);
    expect(csp).toBeLessThan(doc.indexOf("<p id=x>"));
    expect(doc).not.toMatch(/allow-same-origin/);
    expect(() => buildCustomWidgetSrcdoc("x".repeat(CUSTOM_HTML_MAX_BYTES + 1))).toThrow(/100 KB/);
    expect(widgetCreateSchema.safeParse({ kind: "custom_html", config: { html: "é".repeat(CUSTOM_HTML_MAX_BYTES / 2 + 1) } }).success).toBe(false);
    expect(widgetCreateSchema.safeParse({ kind: "metric", config: { href: "javascript:alert(1)" } }).success).toBe(false);
  });

  it("requires a reason when a packet declares no validation", () => {
    const p = { objective: "Ship V5", nextAction: "Open PR" };
    expect(packetSchema.safeParse({ ...p, validationRequired: false }).success).toBe(false);
    expect(packetSchema.parse({ ...p, validationRequired: false, noValidationReason: "Docs only" }).validationRequired).toBe(false);
    expect(packetSchema.parse(p)).toMatchObject({ validationRequired: true, status: "in_progress" });
  });
});

let owner: string, other: string, kid: string;
const cid = "test-correlation";
const me = () => resolveUser(new Headers(), createSession(owner).token)!;
const them = () => resolveUser(new Headers(), createSession(other).token)!;

beforeEach(() => {
  __setTestDatabase();
  owner = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  other = createPerson({ name: "Other", username: "other", role: "adult", passcode: "synthetic-pass" }, owner).id;
  kid = createPerson({ name: "Child", username: "child", role: "kid", passcode: "synthetic-pass" }, owner).id;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function flagship() {
  const u = me();
  const area = store.createItem(u, { kind: "area", title: "Momentum Bets" }, cid);
  const project = store.createItem(u, { kind: "project", title: "Criteria evaluator", parentId: area.id }, cid);
  const items = ["V2 baseline", "V3 parity", "V4 lessons", "V5 evaluator contract"].map((title) =>
    store.createItem(u, { kind: "thread", title, parentId: project.id }, cid),
  );
  return { u, area, project, v5: items[3]! };
}

describe("store (real SQLite)", () => {
  it("runs the flagship journey: packet → PR merged → awaiting validation → evidence → settle → reopen", async () => {
    const { u, project, v5 } = flagship();
    expect(store.listItems(owner).find((i) => i.builtIn)?.title).toBe("Miscellaneous");
    const bug = store.splitItem(u, v5.id, { title: "Hydration perf bug", summary: "p95 hydration regressed" }, cid);
    expect(bug.parentId).toBe(v5.id);
    expect(store.getDetail(owner, bug.id).lineage[0]).toMatchObject({ relation: "split_from", parentId: v5.id });
    expect(() => store.updateItem(u, v5.id, { status: "in_progress" }, cid)).toThrow(/next action/);
    const packet = store.createPacket(
      u,
      v5.id,
      packetSchema.parse({ objective: "Define the V5 evaluator contract", nextAction: "Open the PR", decisions: "Keep V4 scoring" }),
      cid,
    );
    expect(packet.version).toBe(1);
    expect(store.getDetail(owner, v5.id).item).toMatchObject({ status: "in_progress", nextAction: "Open the PR" });
    expect(store.createPacket(u, v5.id, packetSchema.parse({ objective: "Revised", nextAction: "Open the PR" }), cid).version).toBe(2);
    // Earlier versions are kept untouched.
    expect(store.getDetail(owner, v5.id).packets.map((p) => [p.version, p.objective])).toEqual([
      [2, "Revised"],
      [1, "Define the V5 evaluator contract"],
    ]);

    const link = await store.addLink(u, v5.id, { kind: "github_pr", url: "https://github.com/NickBolles/momentum-bets/pull/128" }, cid);
    expect(link).toMatchObject({ kind: "github_pr", role: "implementation", externalState: "open", targetId: "NickBolles/momentum-bets#128" });
    store.setLinkState(u, link.id, "merged", cid);
    let d = store.getDetail(owner, v5.id);
    expect(d.item.status).toBe("awaiting_validation");
    expect(d.events.some((e) => e.kind === "merged")).toBe(true);
    expect(d.settle.allowed).toBe(false);
    expect(() => store.settleItem(u, v5.id, undefined, cid)).toThrow(/requires validation/);

    const v = store.addValidation(u, v5.id, { metric: "p95 hydration", comparator: "<=", threshold: 800, unit: "ms", baseline: 1200 }, cid);
    store.updateValidation(u, v.id, { observed: 950 }, cid);
    d = store.getDetail(owner, v5.id);
    expect(d.validations[0]!.status).toBe("fail");
    expect(d.settle.reason).toMatch(/failed/);
    store.updateValidation(u, v.id, { observed: 640, evidenceUrl: "https://example.com/run/1" }, cid);
    expect(store.getDetail(owner, v5.id).settle.allowed).toBe(true);
    const settled = store.settleItem(u, v5.id, "p95 640 ms", cid);
    expect(settled).toMatchObject({ status: "settled", settledKind: "manual", settledReason: "p95 640 ms" });
    expect(settled.completedAt).toBeTruthy();

    const { item, followUp } = store.reopenItem(u, v5.id, { reason: "Regressed on mobile", followUpTitle: "Mobile hydration follow-up" }, cid);
    expect(item).toMatchObject({ status: "reopened", settledKind: null, completedAt: null });
    expect(followUp).toMatchObject({ parentId: v5.id, title: "Mobile hydration follow-up" });
    expect(store.getDetail(owner, followUp!.id).lineage[0]).toMatchObject({ relation: "handoff_from", parentId: v5.id });

    const events = store.getDetail(owner, v5.id).events.filter((e) => e.kind === "status");
    expect(events.map((e) => e.toStatus).reverse()).toEqual(["in_progress", "awaiting_validation", "settled", "reopened"]);
    const actions = recentAudit(200).map((a) => a.action);
    expect(actions.filter((a) => a === "work.status").length).toBeGreaterThanOrEqual(4);
    expect(actions).toContain("work.packet");
    expect(actions).toContain("work.link_state");

    // Timeline actuals come from events.
    const t = store.timeline(owner, project.id);
    expect(t.rows.map((r) => [r.title, r.depth]).slice(0, 2)).toEqual([
      ["Criteria evaluator", 0],
      ["V2 baseline", 1],
    ]);
    expect(t.rows.find((r) => r.id === v5.id)!.actuals.map((a) => a.kind)).toEqual(["started", "merged"]);
  });

  it("auto-settles a merged PR when the packet declares no validation, and reopens in one step", async () => {
    const { u, v5 } = flagship();
    store.createPacket(
      u,
      v5.id,
      packetSchema.parse({ objective: "Rename", nextAction: "Merge", validationRequired: false, noValidationReason: "Rename only" }),
      cid,
    );
    const link = await store.addLink(u, v5.id, { kind: "github_pr", url: "https://github.com/o/r/pull/9" }, cid);
    store.setLinkState(u, link.id, "merged", cid);
    expect(store.getDetail(owner, v5.id).item).toMatchObject({ status: "settled", settledKind: "auto", settledReason: "PR #9 merged; no validation required" });
    expect(store.reopenItem(u, v5.id, { reason: "Not done" }, cid).item.status).toBe("reopened");
    // A reference PR (not implementation) never changes item state.
    const ref = await store.addLink(u, v5.id, { kind: "github_pr", url: "https://github.com/o/r/pull/10", role: "reference" }, cid);
    store.setLinkState(u, ref.id, "merged", cid);
    expect(store.getDetail(owner, v5.id).item.status).toBe("reopened");
  });

  it("moves without cycles, records lineage, forks with source links, archives and reorders", async () => {
    const { u, area, project, v5 } = flagship();
    const bug = store.splitItem(u, v5.id, { title: "Hydration perf bug" }, cid);
    expect(() => store.moveItem(u, project.id, bug.id, cid)).toThrow(/inside itself/);
    expect(() => store.moveItem(u, v5.id, null, cid)).toThrow(/Only areas/);
    store.moveItem(u, bug.id, area.id, cid);
    expect(store.getDetail(owner, bug.id)).toMatchObject({ item: { parentId: area.id }, breadcrumb: [{ title: "Momentum Bets" }] });
    expect(store.getDetail(owner, bug.id).lineage.find((l) => l.relation === "moved_from")).toMatchObject({ fromParentId: v5.id, toParentId: area.id });

    await store.addLink(u, v5.id, { kind: "url", url: "https://example.com/spec", role: "source", title: "Spec" }, cid);
    await store.addLink(u, v5.id, { kind: "url", url: "https://example.com/other" }, cid);
    const fork = store.forkItem(u, v5.id, undefined, cid);
    expect(fork).toMatchObject({ parentId: project.id, title: "V5 evaluator contract (fork)" });
    expect(store.getDetail(owner, fork.id).links.map((l) => l.title)).toEqual(["Spec"]);
    expect(store.getDetail(owner, fork.id).lineage[0]).toMatchObject({ relation: "forked_from", parentId: v5.id });

    const kids = () =>
      store
        .listItems(owner)
        .filter((i) => i.parentId === project.id)
        .map((i) => i.title);
    store.reorderItem(u, fork.id, "up");
    expect(kids().slice(-2)).toEqual(["V5 evaluator contract (fork)", "V5 evaluator contract"]);
    store.updateItem(u, fork.id, { archived: true }, cid);
    expect(kids()).not.toContain("V5 evaluator contract (fork)");
    expect(store.listItems(owner, { includeArchived: true }).some((i) => i.id === fork.id)).toBe(true);
    // Non-areas without a parent land in Miscellaneous; it can't be archived.
    const loose = store.createItem(u, { kind: "note", title: "Loose idea" }, cid);
    const misc = store.listItems(owner).find((i) => i.builtIn)!;
    expect(loose.parentId).toBe(misc.id);
    expect(() => store.updateItem(u, misc.id, { archived: true }, cid)).toThrow(/built in/);
  });

  it("keeps everything private to its owner", async () => {
    const { v5 } = flagship();
    expect(store.listItems(other).map((i) => i.title)).toEqual(["Miscellaneous"]);
    expect(() => store.getDetail(other, v5.id)).toThrow(/not found/);
    expect(() => store.updateItem(them(), v5.id, { title: "x" }, cid)).toThrow(/not found/);
    const link = await store.addLink(me(), v5.id, { kind: "github_pr", url: "https://github.com/o/r/pull/1" }, cid);
    expect(() => store.setLinkState(them(), link.id, "merged", cid)).toThrow(/not found/);
    const misc = store.listItems(other)[0]!;
    expect(() => store.moveItem(them(), misc.id, v5.id, cid)).toThrow();
    expect(() => store.createItem(them(), { kind: "thread", title: "x", parentId: v5.id }, cid)).toThrow(/not found/);
    const found = await search(me(), "evaluator");
    expect(found.results.filter((r) => r.kind === "work").map((r) => r.title)).toContain("V5 evaluator contract");
    expect((await search(them(), "evaluator")).results.filter((r) => r.kind === "work")).toEqual([]);
  });

  it("refreshes PR state read-only from GitHub only when a token is configured", async () => {
    const { u, v5 } = flagship();
    const link = await store.addLink(u, v5.id, { kind: "github_pr", url: "https://github.com/o/r/pull/5" }, cid);
    await expect(store.refreshLink(u, link.id, cid)).rejects.toThrow(/JARVIS_GITHUB_TOKEN/);
    expect(store.getDetail(owner, v5.id).githubRefresh).toBe(false);
    vi.stubEnv("JARVIS_GITHUB_TOKEN", "synthetic-test-value");
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ state: "closed", merged: true, title: "Evaluator V5" }));
    vi.stubGlobal("fetch", fetchMock);
    const refreshed = await store.refreshLink(u, link.id, cid);
    expect(refreshed).toMatchObject({ externalState: "merged", title: "Evaluator V5 (#5)" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/repos/o/r/pulls/5");
    expect(init.method).toBe("GET");
    expect(store.getDetail(owner, v5.id).item.status).toBe("awaiting_validation");
  });
});

describe("dashboard", () => {
  it("creates defaults, computes native widgets and only injects a link-free snapshot when opted in", async () => {
    const { u, area, v5 } = flagship();
    expect(getDashboard(owner).widgets.map((w) => w.kind)).toEqual(["priorities", "awaiting_validation", "next_actions", "recently_settled"]);
    store.createPacket(u, v5.id, packetSchema.parse({ objective: "x", nextAction: "Open the PR" }), cid);
    await store.addLink(u, v5.id, { kind: "url", url: "https://example.com/secret-path" }, cid);
    const d = getDashboard(owner);
    expect(d.widgets[0]!.data).toMatchObject({ kind: "items", items: [{ title: "V5 evaluator contract", status: "in_progress" }] });
    let dash = addWidget(u, { kind: "custom_html", config: { html: "<p>hi</p>", rootId: area.id } }, cid);
    const plain = dash.widgets.at(-1)!;
    expect(plain.data).toEqual({ kind: "custom_html", snapshot: null });
    dash = updateWidget(u, plain.id, { config: { html: "<p>hi</p>", rootId: area.id, injectData: true }, direction: "up" }, cid);
    const injected = dash.widgets.find((w) => w.id === plain.id)!;
    expect(injected.position).toBe(3);
    const snap = (injected.data as { snapshot: { root: string; items: object[] } }).snapshot;
    expect(snap.root).toBe("Momentum Bets");
    expect(snap.items[0]).toEqual({ title: "Momentum Bets", kind: "area", status: "captured", depth: 0, startDate: null, targetDate: null, nextAction: "" });
    expect(JSON.stringify(snap)).not.toContain("example.com");
    expect(() => addWidget(them(), { kind: "project_map", config: { rootId: area.id } }, cid)).toThrow(/not found/);
    expect(getDashboard(other).widgets).toHaveLength(4);
  });
});

async function call(
  handler: (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>,
  opts: { user?: string | null; method?: string; body?: unknown; csrf?: boolean; params?: Record<string, string> } = {},
) {
  const { user = owner, method = "GET", body, csrf = true, params = {} } = opts;
  return handler(
    new NextRequest("http://jarvis.test/api/work", {
      method,
      headers: {
        ...(user ? { cookie: `jarvis_session=${createSession(user).token}` } : {}),
        ...(csrf ? { "x-jarvis-csrf": "1" } : {}),
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    { params: Promise.resolve(params) },
  );
}
type H = Parameters<typeof call>[0];

describe("API boundary", () => {
  it("enforces auth, capability, CSRF, validation and ownership", async () => {
    expect((await call(itemsRoute.GET as H, { user: null })).status).toBe(401);
    expect((await call(itemsRoute.GET as H, { user: kid })).status).toBe(403);
    expect((await call(itemsRoute.GET as H, { user: other })).status).toBe(200);
    expect((await call(itemsRoute.POST as H, { method: "POST", body: { kind: "area", title: "A" }, csrf: false })).status).toBe(403);
    expect((await call(itemsRoute.POST as H, { method: "POST", body: { kind: "galaxy", title: "A" } })).status).toBe(400);
    expect((await call(itemsRoute.POST as H, { method: "POST", body: { kind: "area", title: "A", extra: 1 } })).status).toBe(400);
    const created = await call(itemsRoute.POST as H, { method: "POST", body: { kind: "area", title: "Momentum Bets" } });
    expect(created.status).toBe(200);
    const { item } = (await created.json()) as { item: { id: string } };
    expect((await call(itemRoute.GET as H, { params: { id: item.id } })).status).toBe(200);
    expect((await call(itemRoute.GET as H, { user: other, params: { id: item.id } })).status).toBe(404);
    const child = (await (await call(itemsRoute.POST as H, { method: "POST", body: { kind: "project", title: "P", parentId: item.id } })).json()) as {
      item: { id: string };
    };
    expect((await call(moveRoute.POST as H, { method: "POST", params: { id: item.id }, body: { parentId: child.item.id } })).status).toBe(409);
    expect((await call(itemRoute.PATCH as H, { method: "PATCH", params: { id: child.item.id }, body: { status: "in_progress" } })).status).toBe(409);
    expect((await call(itemRoute.PATCH as H, { method: "PATCH", params: { id: child.item.id }, body: { startDate: "2026-02-30" } })).status).toBe(400);
    expect((await call(settleRoute.POST as H, { method: "POST", params: { id: child.item.id }, body: {} })).status).toBe(200);
    expect((await call(linkRoute.PATCH as H, { method: "PATCH", params: { id: "nope" }, body: { externalState: "merged" } })).status).toBe(404);
    expect((await call(refreshRoute.POST as H, { user: kid, method: "POST", params: { id: "nope" } })).status).toBe(403);
    expect(
      (await call(widgetsRoute.POST as H, { method: "POST", body: { kind: "custom_html", config: { html: "x".repeat(CUSTOM_HTML_MAX_BYTES + 10) } } })).status,
    ).toBe(400);
  });

  it("produces a pasteable markdown handoff", async () => {
    const { u, v5 } = flagship();
    store.createPacket(
      u,
      v5.id,
      packetSchema.parse({ objective: "Define V5", nextAction: "Open the PR", decisions: "- Keep V4 scoring\nDrop V3 weights", openQuestions: "" }),
      cid,
    );
    await store.addLink(u, v5.id, { kind: "github_pr", url: "https://github.com/o/r/pull/3" }, cid);
    const md = handoffMarkdown(store.getDetail(owner, v5.id), "https://jarvis.test");
    expect(md).toContain("# Handoff: V5 evaluator contract");
    expect(md).toContain("**Where:** Momentum Bets › Criteria evaluator › V5 evaluator contract");
    expect(md).toContain("**State:** In progress · packet v1");
    expect(md).toContain("## Decisions\n- Keep V4 scoring\n- Drop V3 weights");
    expect(md).toContain("## Open questions\n- (none)");
    expect(md).toContain("## Next action\nOpen the PR");
    expect(md).toContain("- [implementation] o/r#3 — https://github.com/o/r/pull/3 (open)");
  });
});
