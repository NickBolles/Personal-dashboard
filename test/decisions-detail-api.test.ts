import { beforeEach, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { __setTestDatabase } from "@/server/db";
import { claimInstance, createSession, resolveUser, type CurrentUser } from "@/server/auth";
import { createItem, updateItem, answerDecision } from "@/server/work/store";
import { GET } from "@/app/api/work/decisions/[id]/route";

let owner: CurrentUser;
let cookie: string;
beforeEach(() => {
  __setTestDatabase();
  const userId = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  const session = createSession(userId);
  owner = resolveUser(new Headers(), session.token)!;
  cookie = `jarvis_session=${session.token}`;
});
const get = (id: string, authenticated = true) =>
  GET(new NextRequest(`http://localhost/api/work/decisions/${encodeURIComponent(id)}`, { headers: authenticated ? { cookie } : {} }), {
    params: Promise.resolve({ id }),
  });

it("reads an open decision through the same authorized decisions list and disappears once answered", async () => {
  const item = createItem(owner, { kind: "thread", title: "Alder API review" }, "test");
  updateItem(owner, item.id, { decision: { question: "Which jig?", choices: ["Cedar", "Alder"] } }, "test");
  const key = `item:${item.id}`;
  const response = await get(key);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ entry: { key, kind: "item", itemId: item.id, question: "Which jig?", choices: ["Cedar", "Alder"] } });
  answerDecision(owner, item.id, "Alder", "test");
  expect((await get(key)).status).toBe(404);
});
it("rejects unauthenticated, malformed and missing ids", async () => {
  expect((await get("item:wk_none", false)).status).toBe(401);
  for (const id of ["item:wk_none", "item:../escape", "approval:a/b", "item:one\n"]) expect((await get(id)).status).toBe(404);
});
