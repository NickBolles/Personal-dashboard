/** #86: a fork keeps access to the files its copied messages point at; it can't delete the parent's files. */
import { beforeEach, expect, it } from "vitest";
import { __setTestDatabase } from "@/server/db";
import { claimInstance, userById } from "@/server/auth";
import { createLocalSession, forkLocalSession } from "@/server/assistant/local";
import { saveAssistantSettings } from "@/server/assistant/settings";
import { deleteChatFile, listChatFiles, markFilesSent, readChatFile, saveChatFile } from "@/server/chat/files";

let owner: string;
beforeEach(() => {
  __setTestDatabase();
  owner = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "secret123" });
  saveAssistantSettings({ apiKey: ["sk", "test", "fork"].join("-"), defaultBackend: "claude" });
});

it("files sent before the fork stay readable from the fork", async () => {
  const u = userById(owner)!;
  const parent = createLocalSession(u, "Parent");
  const f = saveChatFile(u, parent.id, { name: "notes.txt", type: "text/plain", bytes: new TextEncoder().encode("garden plan\n") }, "c1");
  markFilesSent([f.id], "run_1");
  const { session: child } = await forkLocalSession(u, parent.id, {}, "c2");
  expect(listChatFiles(u, child.id).map((x) => x.id)).toContain(f.id);
  expect(readChatFile(u, child.id, f.id).row.id).toBe(f.id);
  expect(() => deleteChatFile(u, child.id, f.id, "c3")).toThrow(/forked from/);
  // the parent still owns it
  expect(listChatFiles(u, parent.id).map((x) => x.id)).toEqual([f.id]);
  // a stranger conversation can't read it
  const other = createLocalSession(u, "Other");
  expect(() => readChatFile(u, other.id, f.id)).toThrow(/not found/i);
});
