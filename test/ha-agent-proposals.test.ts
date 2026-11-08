/**
 * Agents may PROPOSE Home Assistant changes, never execute them (owner decision
 * 2026-11-07): the MCP tool raises a Needs-you decision with a House deep link,
 * and executeControl refuses anything running as an agent or scheduled job.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { __setTestDatabase } from "@/server/db";
import { claimInstance, createSession, resolveUser, type CurrentUser } from "@/server/auth";
import * as store from "@/server/work/store";
import { __resetAgentRate, mintAgentToken } from "@/server/agent-access/tokens";
import { executeControl } from "@/integrations/home-assistant/controls";
import { withVia } from "@/server/work/actor";
import { proposalHref } from "@/server/agent-access/ha-proposals";
import { parseDecision, serialiseDecision } from "@/lib/decisions";
import * as mcpRoute from "@/app/api/mcp/route";

let owner: CurrentUser;
let n = 0;

async function call(token: string, name: string, args: Record<string, unknown>) {
  const res = await mcpRoute.POST(
    new NextRequest("http://localhost/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const j = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read arbitrary tool JSON
  return { isError: !!j.result.isError, value: JSON.parse(j.result.content[0]!.text) as Record<string, any> };
}

describe("agent device proposals", () => {
  beforeEach(() => {
    __setTestDatabase();
    __resetAgentRate();
    const id = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
    owner = resolveUser(new Headers(), createSession(id).token)!;
  });

  it("a proposal becomes a Needs-you decision with a House confirm link; nothing is operated", async () => {
    const { token } = mintAgentToken(owner, { name: "Chief", profile: "chiefofstaff", scopes: ["work.read", "decisions.write"] }, "t");
    const area = store.createItem(owner, { kind: "area", title: "Home" }, "t");
    const item = store.createItem(owner, { parentId: area.id, kind: "thread", title: "Secure the house tonight" }, "t");
    const r = await call(token, "jarvis_propose_device_change", {
      itemId: item.id,
      entityId: "lock.front_door_lock",
      service: "unlock",
      reason: "Guest arriving at 6",
    });
    expect(r.isError).toBe(false);
    expect(r.value).toMatchObject({ proposed: true, executed: false, risk: "high", confirmAt: "/home-control?entity=lock.front_door_lock&propose=unlock" });
    const d = store.listItems(owner.id).find((x) => x.id === item.id)?.decision;
    expect(d?.question).toMatch(/@chiefofstaff proposes a device change \(HIGH-RISK\): Unlock lock\.front_door_lock/);
    // #238: the House link is a tappable decision action, not text inside the question.
    expect(d?.action).toEqual({ label: "Confirm on House", href: "/home-control?entity=lock.front_door_lock&propose=unlock" });
    expect(d?.question).not.toContain("/home-control");
  });

  it("decision actions only keep same-origin app paths (#238)", () => {
    const at = "2026-11-07T00:00:00Z";
    expect(parseDecision(serialiseDecision({ question: "q", action: { label: "Go", href: "/home-control?entity=x" } }, at))?.action).toEqual({
      label: "Go",
      href: "/home-control?entity=x",
    });
    for (const href of ["//evil.example/x", "https://evil.example", "javascript:alert(1)", "/\\evil", "/a b"])
      expect(parseDecision(serialiseDecision({ question: "q", action: { label: "Go", href } }, at))?.action).toBeUndefined();
  });

  it("refuses services outside the policy and bad payloads", async () => {
    const { token } = mintAgentToken(owner, { name: "Chief", profile: "chiefofstaff", scopes: ["work.read", "decisions.write"] }, "t");
    const item = store.createItem(owner, { kind: "area", title: "House" }, "t");
    expect((await call(token, "jarvis_propose_device_change", { itemId: item.id, entityId: "shell_command.x", service: "run", reason: "x" })).isError).toBe(
      true,
    );
    expect(
      (
        await call(token, "jarvis_propose_device_change", {
          itemId: item.id,
          entityId: "light.k",
          service: "turn_on",
          data: { brightness_pct: 900 },
          reason: "x",
        })
      ).isError,
    ).toBe(true);
    expect(proposalHref("light.k", "turn_on", { brightness_pct: 40 })).toBe(
      "/home-control?entity=light.k&propose=turn_on&data=%7B%22brightness_pct%22%3A40%7D",
    );
  });

  it("executeControl refuses agents and scheduled jobs before touching Home Assistant", async () => {
    for (const via of ["agent:chiefofstaff", "job:nightly"]) {
      await expect(
        withVia(via, () => executeControl({ entityId: "light.kitchen", service: "turn_off", stateToken: "abcd1234", confirmed: true }, owner.id, "t")),
      ).rejects.toThrow(/propose/);
    }
  });
});
