/** Sub-agent live transcript reads: strict path validation, tail limits, masking, owner-only route, own-profile MCP tool. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { __setTestDatabase } from "@/server/db";
import { claimInstance, createSession, resolveUser, type CurrentUser } from "@/server/auth";
import { createPerson } from "@/server/people";
import { __resetAgentRate, mintAgentToken } from "@/server/agent-access/tokens";
import { LOG_TAIL_MAX, clampTail, parseTranscriptPath, readSubagentLog, redactLog, validRef } from "@/server/chat/subagent-log";
import * as logRoute from "@/app/api/hermes/subagent-log/route";
import * as mcpRoute from "@/app/api/mcp/route";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-sublog-"));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-sublog-outside-"));
process.env.JARVIS_DELEGATION_LOG_ROOT = root;
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
  delete process.env.JARVIS_DELEGATION_LOG_ROOT;
});

function writeLog(profile: string, id: string, task: number, text: string) {
  const dir = path.join(root, profile, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `task-${task}.log`), text);
}
// Built at run time so the repo's secret scan never sees a literal credential.
const fakeToken = () => ["ghp", "_", "Zx9".repeat(12)].join("");

let owner: CurrentUser;
let session: string;
let otherSession: string;
let n = 0;
const ctx = () => ({ params: Promise.resolve({}) });
const get = (qs: string, s = session) =>
  logRoute.GET(new NextRequest(`http://localhost/api/hermes/subagent-log?${qs}`, { headers: { cookie: `jarvis_session=${s}` } }), ctx());

beforeEach(() => {
  __setTestDatabase();
  __resetAgentRate();
  const id = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  session = createSession(id).token;
  owner = resolveUser(new Headers(), session)!;
  const other = createPerson({ name: "Other", username: "other", role: "adult", passcode: "synthetic-pass" }, owner.id).id;
  otherSession = createSession(other).token;
});

describe("transcript paths", () => {
  it("parses Hermes' live log paths for named and default profiles", () => {
    expect(parseTranscriptPath("/home/hermes/.hermes/profiles/chiefofstaff/cache/delegation/live/deleg_15800dfe/task-3.log")).toEqual({
      profile: "chiefofstaff",
      delegationId: "deleg_15800dfe",
      task: 3,
    });
    expect(parseTranscriptPath("/opt/data/.hermes/cache/delegation/live/deleg_abcdef12/task-0.log")).toEqual({
      profile: "default",
      delegationId: "deleg_abcdef12",
      task: 0,
    });
  });
  it("refuses anything that isn't exactly a live log", () => {
    for (const p of [
      "/etc/passwd",
      "/home/hermes/.hermes/profiles/chiefofstaff/.env",
      "/home/hermes/.hermes/profiles/chiefofstaff/cache/delegation/live/deleg_15800dfe/manifest.json",
      "/home/hermes/.hermes/profiles/../cache/delegation/live/deleg_15800dfe/task-0.log",
      "/home/hermes/.hermes/profiles/x/cache/delegation/live/deleg_15800dfe/../deleg_1/task-0.log",
      "/home/hermes/.hermes/profiles/Chief/cache/delegation/live/deleg_15800dfe/task-0.log",
      "/home/hermes/.hermes/profiles/x/cache/delegation/live/deleg_XYZ/task-0.log",
      "/home/hermes/.hermes/profiles/x/cache/delegation/live/deleg_15800dfe/task-999.log",
      "cache/delegation/live/deleg_15800dfe/task-0.log\0",
    ])
      expect(parseTranscriptPath(p), p).toBeNull();
  });
  it("validates each part and clamps the tail", () => {
    expect(() => validRef({ profile: "../x", delegationId: "deleg_15800dfe", task: 0 })).toThrow();
    expect(() => validRef({ profile: "x", delegationId: "deleg_15800dfe/..", task: 0 })).toThrow();
    expect(() => validRef({ profile: "x", delegationId: "deleg_15800dfe", task: 64 })).toThrow();
    expect(() => validRef({ profile: "x", delegationId: "deleg_15800dfe", task: "1e1" })).toThrow();
    expect(validRef({ profile: "x", delegationId: "deleg_15800dfe", task: "7" }).task).toBe(7);
    expect(clampTail(undefined)).toBe(64 * 1024);
    expect(clampTail("10")).toBe(10);
    expect(clampTail(10 ** 9)).toBe(LOG_TAIL_MAX);
    expect(() => clampTail("-1")).toThrow();
    expect(() => clampTail("abc")).toThrow();
  });
});

describe("readSubagentLog", () => {
  it("returns the tail, drops the cut first line and masks credentials", () => {
    const secret = fakeToken();
    writeLog("devchief", "deleg_0a1b2c3d", 1, `first line\nsecond line\nGITHUB_TOKEN=${secret}\nAuthorization: Bearer ${secret}\nlast line\n`);
    const full = readSubagentLog({ profile: "devchief", delegationId: "deleg_0a1b2c3d", task: 1 });
    expect(full.truncated).toBe(false);
    expect(full.text).toContain("first line");
    expect(full.text).toContain("last line");
    expect(full.text).not.toContain(secret);
    expect(full.masked).toBeGreaterThan(0);
    const tail = readSubagentLog({ profile: "devchief", delegationId: "deleg_0a1b2c3d", task: 1 }, 15);
    expect(tail.truncated).toBe(true);
    expect(tail.text).toBe("last line\n");
    expect(tail.size).toBe(full.size);
  });
  it("never returns a context-free fragment of an unterminated line", () => {
    writeLog("devchief", "deleg_0a1b2c3e", 0, "start\npassword=synthetic123456");
    const cut = readSubagentLog({ profile: "devchief", delegationId: "deleg_0a1b2c3e", task: 0 }, 15);
    expect(cut).toMatchObject({ truncated: true, text: "" });
    const whole = readSubagentLog({ profile: "devchief", delegationId: "deleg_0a1b2c3e", task: 0 });
    expect(whole.text).not.toContain("synthetic123456");
  });
  it("answers not_found for a missing log and a symlink out of the profile folder", () => {
    expect(() => readSubagentLog({ profile: "devchief", delegationId: "deleg_ffffffff", task: 0 })).toThrow(/No log/);
    fs.writeFileSync(path.join(outside, "secret.log"), "outside");
    fs.mkdirSync(path.join(root, "devchief", "deleg_eeeeeeee"), { recursive: true });
    fs.symlinkSync(path.join(outside, "secret.log"), path.join(root, "devchief", "deleg_eeeeeeee", "task-0.log"));
    expect(() => readSubagentLog({ profile: "devchief", delegationId: "deleg_eeeeeeee", task: 0 })).toThrow(/No log/);
    fs.symlinkSync(outside, path.join(root, "linked"));
    fs.mkdirSync(path.join(outside, "deleg_dddddddd"));
    fs.writeFileSync(path.join(outside, "deleg_dddddddd", "task-0.log"), "outside");
    expect(() => readSubagentLog({ profile: "linked", delegationId: "deleg_dddddddd", task: 0 })).toThrow(/No log/);
  });
  it("redactLog leaves ordinary text alone", () => {
    expect(redactLog("ran npm test: 12 passed")).toEqual({ text: "ran npm test: 12 passed", masked: 0 });
  });
});

describe("GET /api/hermes/subagent-log", () => {
  it("serves the owner by path or by parts, no-store", async () => {
    writeLog("chiefofstaff", "deleg_12345678", 0, "hello from the sub-agent\n");
    const byPath = await get(`path=${encodeURIComponent("/home/hermes/.hermes/profiles/chiefofstaff/cache/delegation/live/deleg_12345678/task-0.log")}`);
    expect(byPath.status).toBe(200);
    expect(byPath.headers.get("cache-control")).toBe("no-store");
    expect((await byPath.json()).text).toBe("hello from the sub-agent\n");
    const byParts = await get("profile=chiefofstaff&delegationId=deleg_12345678&task=0&tail=6");
    expect(byParts.status).toBe(200);
    expect(await byParts.json()).toMatchObject({ truncated: true, profile: "chiefofstaff", task: 0 });
  });
  it("refuses bad paths, other people and signed-out requests", async () => {
    expect((await get(`path=${encodeURIComponent("/home/hermes/.hermes/profiles/chiefofstaff/.env")}`)).status).toBe(400);
    expect((await get("profile=..&delegationId=deleg_12345678&task=0")).status).toBe(400);
    expect((await get("profile=chiefofstaff&delegationId=deleg_12345678&task=0", otherSession)).status).toBe(403);
    expect((await get("profile=chiefofstaff&delegationId=deleg_12345678&task=0", "nope")).status).toBe(401);
    expect((await get("profile=chiefofstaff&delegationId=deleg_99999999&task=0")).status).toBe(404);
  });
  it("answers 503 when the logs aren't mounted", async () => {
    process.env.JARVIS_DELEGATION_LOG_ROOT = path.join(root, "missing-root");
    try {
      expect((await get("profile=chiefofstaff&delegationId=deleg_12345678&task=0")).status).toBe(503);
    } finally {
      process.env.JARVIS_DELEGATION_LOG_ROOT = root;
    }
  });
});

describe("jarvis_read_subagent_log", () => {
  async function call(token: string, args: Record<string, unknown>) {
    const res = await mcpRoute.POST(
      new NextRequest("http://localhost/api/mcp", {
        method: "POST",
        headers: { authorization: ["Bearer", token].join(" "), "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name: "jarvis_read_subagent_log", arguments: args } }),
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    return { isError: !!json.result.isError, value: JSON.parse(json.result.content[0].text) };
  }
  it("reads the agent's own sub-agent logs only", async () => {
    writeLog("devchief", "deleg_abcabcab", 2, "devchief child\n");
    writeLog("homelabchief", "deleg_abcabcab", 2, "homelab child\n");
    const token = mintAgentToken(owner, { name: "Dev", profile: "devchief", scopes: ["work.read", "runs.write"] }, "t").token;
    const own = await call(token, { delegationId: "deleg_abcabcab", task: 2 });
    expect(own.isError).toBe(false);
    expect(own.value.text).toBe("devchief child\n");
    const viaPath = await call(token, { path: "/home/hermes/.hermes/profiles/devchief/cache/delegation/live/deleg_abcabcab/task-2.log" });
    expect(viaPath.value.text).toBe("devchief child\n");
    const theirs = await call(token, { path: "/home/hermes/.hermes/profiles/homelabchief/cache/delegation/live/deleg_abcabcab/task-2.log" });
    expect(theirs.isError).toBe(true);
    expect(JSON.stringify(theirs.value)).not.toContain("homelab child");
  });
  it("needs the runs.write scope", async () => {
    const token = mintAgentToken(owner, { name: "Reader", profile: "devchief", scopes: ["work.read"] }, "t").token;
    const r = await call(token, { delegationId: "deleg_abcabcab", task: 2 });
    expect(r.isError).toBe(true);
  });
});
