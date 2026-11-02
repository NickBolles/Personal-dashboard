import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { __setTestDatabase } from "@/server/db";
import { claimInstance, createSession } from "@/server/auth";
import { createPerson } from "@/server/people";
import * as listRoute from "@/app/api/workflows/route";
import * as itemRoute from "@/app/api/workflows/[id]/route";
import * as versionRoute from "@/app/api/workflows/[id]/versions/[version]/route";
import * as restoreRoute from "@/app/api/workflows/[id]/versions/[version]/restore/route";
import * as validateRoute from "@/app/api/workflows/validate/route";
import { blankDefinition } from "@/lib/workflows/builder";

let owner: string;
let other: string;

function call(handler: unknown, opts: { method?: string; body?: unknown; as?: string; params?: Record<string, string> } = {}) {
  const { method = "POST", body, as = owner, params = {} } = opts;
  return (handler as (r: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>)(
    new NextRequest("http://jarvis.test/api/workflows", {
      method,
      headers: { cookie: `jarvis_session=${createSession(as).token}`, "x-jarvis-csrf": "1", "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    { params: Promise.resolve(params) },
  );
}

beforeEach(() => {
  __setTestDatabase();
  owner = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  other = createPerson({ name: "Other", username: "other", role: "adult", passcode: "synthetic-pass" }, owner).id;
});

describe("workflow versions API", () => {
  it("save v2 → diff → restore v1 creates v3 with v1's content", async () => {
    const v1 = { ...blankDefinition("Sermon log", "sermonlog"), instructions: "First wording." };
    const created = await call(listRoute.POST, { body: { definition: v1 } });
    expect(created.status).toBe(200);
    const { workflow } = (await created.json()) as { workflow: { id: string } };
    const id = workflow.id;
    const saved = await call(itemRoute.PUT, {
      method: "PUT",
      params: { id },
      body: { definition: { ...v1, instructions: "Second wording." }, changeNote: "Tighter" },
    });
    expect(saved.status).toBe(200);

    const v2 = (await (await call(versionRoute.GET, { method: "GET", params: { id, version: "2" } })).json()) as {
      changes: { path: string; kind: string }[];
      summary: string;
      current: number;
    };
    expect(v2.current).toBe(2);
    expect(v2.changes).toEqual([expect.objectContaining({ path: "instructions", kind: "changed" })]);
    expect(v2.summary).toBe("1 change: instructions");

    const restored = await call(restoreRoute.POST, { params: { id, version: "1" } });
    expect(restored.status).toBe(200);
    const after = (await restored.json()) as { definition: { instructions: string }; versions: { version: number; changeNote: string | null }[] };
    expect(after.definition.instructions).toBe("First wording.");
    expect(after.versions[0]).toMatchObject({ version: 3, changeNote: "Restored v1" });
  });

  it("is owner-scoped and rejects bad versions", async () => {
    const created = await call(listRoute.POST, { body: { definition: blankDefinition("Mine", "minewf") } });
    const { workflow } = (await created.json()) as { workflow: { id: string } };
    expect((await call(versionRoute.GET, { method: "GET", params: { id: workflow.id, version: "1" }, as: other })).status).toBe(404);
    expect((await call(versionRoute.GET, { method: "GET", params: { id: workflow.id, version: "0" } })).status).toBe(400);
    expect((await call(restoreRoute.POST, { params: { id: workflow.id, version: "9" } })).status).toBe(404);
  });

  it("validates a draft without saving (Finance refused)", async () => {
    const ok = (await (await call(validateRoute.POST, { body: { definition: blankDefinition() } })).json()) as { ok: boolean };
    expect(ok.ok).toBe(true);
    const fin = (await (
      await call(validateRoute.POST, { body: { definition: { ...blankDefinition(), routing: { area: "Finance", agentProfile: null, modelTier: "fast" } } } })
    ).json()) as { ok: boolean; issues: { code: string }[] };
    expect(fin.ok).toBe(false);
    expect(fin.issues.map((i) => i.code)).toContain("finance_excluded");
    const list = (await (await call(listRoute.GET, { method: "GET" })).json()) as { workflows: unknown[] };
    expect(list.workflows).toEqual([]);
  });
});
