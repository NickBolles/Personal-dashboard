import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession } from "@/server/auth";
import { DRIVE_FILE_SCOPE, driveFileName, driveScopes, resolveDriveFolder } from "@/lib/workflows/drive-path";
import { lookupPassage, parseVpl, WEB_PACK_PIN } from "@/lib/bible/web";
import { parseScriptureRef } from "@/lib/workflows/scripture";
import { __forgetLoadedPack, installPack, loadPack, sha256Hex, unzipEntry, verifySha256 } from "@/server/bible/store";
import { driveAuthorizationUrl } from "@/server/drive/google-drive";
import * as importRoute from "@/app/api/workflows/import/route";
import * as itemRoute from "@/app/api/workflows/[id]/route";
import * as formRoute from "@/app/api/workflows/form/route";
import * as runsRoute from "@/app/api/workflows/runs/route";
import * as driveRunRoute from "@/app/api/workflows/runs/[runId]/drive/route";
import * as driveRoute from "@/app/api/integrations/drive/route";
import * as passageRoute from "@/app/api/bible/passage/route";
import * as bibleRoute from "@/app/api/bible/route";
import teaching from "@/lib/workflows/fixtures/teaching-notes.json";

// e2e/fixtures/bible/engwebp_vpl.zip: 66 one-verse books + John 3:16–17, John 15:1–5, Psalm 23:1–2
const FIXTURE = path.resolve("e2e/fixtures/bible/engwebp_vpl.zip");
const FIXTURE_SHA = "e73a9d4d552f3be40c549c12a99df12ffaf71c2fbce764b96be6ba086c793a7a";

let owner: string;
let dataDir: string;
const ENV = [
  "JARVIS_DATA_DIR",
  "JARVIS_ENABLE_DRIVE_EXPORT",
  "JARVIS_DRIVE_CLIENT_ID",
  "JARVIS_DRIVE_CLIENT_SECRET",
  "JARVIS_BIBLE_PACK_URL",
  "JARVIS_BIBLE_PACK_SHA256",
];
const saved: Record<string, string | undefined> = {};

function call(handler: unknown, opts: { method?: string; body?: unknown; params?: Record<string, string>; url?: string } = {}) {
  const { method = "GET", body, params = {}, url = "http://jarvis.test/api/x" } = opts;
  return (handler as (r: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>)(
    new NextRequest(url, {
      method,
      headers: { cookie: `jarvis_session=${createSession(owner).token}`, "x-jarvis-csrf": "1", "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    { params: Promise.resolve(params) },
  );
}
async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  const b = (await r.json()) as T;
  expect(r.status, JSON.stringify(b)).toBe(status);
  return b;
}

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-bible-"));
  process.env.JARVIS_DATA_DIR = dataDir;
  __setTestDatabase();
  owner = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("Drive path template (#141)", () => {
  it("expands {yyyy}/{mm}/{dd} from the local start date", () => {
    expect(resolveDriveFolder("Teaching notes/{yyyy}", "2026-11-01")).toEqual({
      ok: true,
      segments: ["Teaching notes", "2026"],
      display: "Teaching notes › 2026",
    });
    expect(resolveDriveFolder("Notes/{yyyy}/{mm}-{dd}", "2027-01-09T10:00:00Z")).toMatchObject({ segments: ["Notes", "2027", "01-09"] });
    expect(resolveDriveFolder(null, "2026-11-01")).toMatchObject({ segments: ["Teaching notes", "2026"] });
    expect(resolveDriveFolder(" /a//b/ ", "2026-11-01")).toMatchObject({ segments: ["a", "b"] });
  });
  it("rejects unsafe or unknown templates", () => {
    expect(resolveDriveFolder("../x", "2026-11-01").ok).toBe(false);
    expect(resolveDriveFolder("x/{user}", "2026-11-01").ok).toBe(false);
    expect(resolveDriveFolder("a/b/c/d/e/f", "2026-11-01").ok).toBe(false);
    expect(resolveDriveFolder("x", "not a date").ok).toBe(false);
  });
  it("builds a slash-free file name with the date", () => {
    expect(driveFileName("Session: A/B – Jake Fry", "2026-11-01")).toBe("Session: A B – Jake Fry (2026-11-01)");
    expect(driveFileName("", "2026-11-01")).toBe("Session (2026-11-01)");
  });
});

describe("Drive scope (#141)", () => {
  it("asks for drive.file only, incrementally, and only when the flag is on", () => {
    expect(driveScopes()).toEqual(["https://www.googleapis.com/auth/drive.file"]);
    delete process.env.JARVIS_ENABLE_DRIVE_EXPORT;
    expect(() => driveAuthorizationUrl("https://j.test/cb", "s")).toThrow(/isn't turned on/);
    process.env.JARVIS_ENABLE_DRIVE_EXPORT = "1";
    process.env.JARVIS_DRIVE_CLIENT_ID = "cid";
    process.env.JARVIS_DRIVE_CLIENT_SECRET = "csecret";
    const u = new URL(driveAuthorizationUrl("https://j.test/cb", "st8"));
    expect(u.searchParams.get("scope")).toBe(DRIVE_FILE_SCOPE);
    expect(u.searchParams.get("include_granted_scopes")).toBe("true");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("state")).toBe("st8");
    expect(u.toString()).not.toContain("client_secret");
  });
  it("status never exposes tokens and reports the flag", async () => {
    const s = await json<Record<string, unknown>>(call(driveRoute.GET));
    expect(s).toMatchObject({ available: false, connected: false, scope: DRIVE_FILE_SCOPE });
  });
});

describe("Drive save (#141, confirmed)", () => {
  it("saves only the confirmed path, creates folders on demand, records the link", async () => {
    process.env.JARVIS_ENABLE_DRIVE_EXPORT = "1";
    process.env.JARVIS_DRIVE_CLIENT_ID = "cid";
    process.env.JARVIS_DRIVE_CLIENT_SECRET = "csecret";
    const { encrypt } = await import("@/server/crypto");
    const { setSetting } = await import("@/server/settings");
    setSetting("drive.connection", { refreshToken: encrypt("rt"), connectedAt: "2026-11-01T00:00:00Z", scope: DRIVE_FILE_SCOPE });
    const calls: { url: string; method: string; body?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
        const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
        if (url.includes("/token")) return ok({ access_token: "at", expires_in: 3600 });
        if (url.includes("/upload/drive/v3/files")) return ok({ id: "doc1", name: "x", webViewLink: "https://docs.google.com/document/d/doc1/edit" });
        if (url.includes("/drive/v3/files") && (init?.method ?? "GET") === "GET") return ok({ files: [] });
        if (url.includes("/drive/v3/files")) return ok({ id: `folder${calls.length}`, name: "f" });
        return new Response("{}", { status: 404 });
      }),
    );
    const { results } = await json<{ results: { id: string }[] }>(call(importRoute.POST, { method: "POST", body: { data: teaching } }));
    await json(call(itemRoute.PATCH, { method: "PATCH", body: { status: "active" }, params: { id: results[0].id } }));
    const form = await json<{ values: Record<string, { value: unknown }> }>(
      call(formRoute.POST, { method: "POST", body: { command: "/teaching Jake Fry John 15" } }),
    );
    const values = Object.fromEntries(Object.entries(form.values).map(([k, v]) => [k, v.value]));
    const started = await json<{ run: { id: string } }>(call(runsRoute.POST, { method: "POST", body: { workflowId: results[0].id, values } }));
    const id = started.run.id;
    const plan = await json<{ path: string; fileName: string; folder: string[] }>(call(driveRunRoute.GET, { params: { runId: id } }));
    expect(plan.path).toMatch(/^My Drive › Teaching notes › \d{4}$/);
    await json(call(driveRunRoute.POST, { method: "POST", body: { path: "My Drive › Elsewhere", fileName: plan.fileName }, params: { runId: id } }), 409);
    expect(calls.some((c) => c.url.includes("/upload/"))).toBe(false);
    const out = await json<{ saved: { url: string; kind: string }; run: { driveExport: { url: string; path: string } } }>(
      call(driveRunRoute.POST, { method: "POST", body: { path: plan.path, fileName: plan.fileName }, params: { runId: id } }),
    );
    expect(out.saved.kind).toBe("doc");
    expect(out.run.driveExport).toMatchObject({ url: "https://docs.google.com/document/d/doc1/edit", path: plan.path });
    // two folder levels looked up and created, then one upload converted to a Google Doc
    expect(calls.filter((c) => c.url.includes("/drive/v3/files") && !c.url.includes("/upload/") && c.method === "POST")).toHaveLength(2);
    const up = calls.find((c) => c.url.includes("/upload/"))!;
    expect(up.body).toContain("application/vnd.google-apps.document");
    const rows = getDb().select().from(schema.auditLog).all();
    expect(rows.some((r) => r.action === "workflow.export.drive" && r.result === "ok")).toBe(true);
  });
});

describe("Drive disconnect (#141)", () => {
  it("keeps a Google grant shared with Tasks (forgets Drive only); revokes a Drive-only grant", async () => {
    process.env.JARVIS_ENABLE_DRIVE_EXPORT = "1";
    delete process.env.JARVIS_DRIVE_CLIENT_ID;
    const { encrypt } = await import("@/server/crypto");
    const { setSetting } = await import("@/server/settings");
    const { saveIntegration } = await import("@/integrations/store");
    const revokes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        revokes.push(String(input));
        return new Response("{}", { status: 200 });
      }),
    );
    saveIntegration("todos", {
      enabled: true,
      config: { provider: "google_tasks", clientId: "cid" },
      secrets: { clientSecret: "cs", refreshToken: "tasks-rt" },
    });
    setSetting("drive.connection", { refreshToken: encrypt("rt"), connectedAt: "2026-11-01T00:00:00Z", scope: DRIVE_FILE_SCOPE });
    const shared = await json<{ connected: boolean; revoked: boolean; keptSharedGrant?: boolean }>(call(driveRoute.DELETE, { method: "DELETE" }));
    expect(shared).toMatchObject({ connected: false, revoked: false, keptSharedGrant: true });
    expect(revokes).toHaveLength(0);
    process.env.JARVIS_DRIVE_CLIENT_ID = "drive-only";
    setSetting("drive.connection", { refreshToken: encrypt("rt2"), connectedAt: "2026-11-01T00:00:00Z", scope: DRIVE_FILE_SCOPE });
    const own = await json<{ revoked: boolean }>(call(driveRoute.DELETE, { method: "DELETE" }));
    expect(own.revoked).toBe(true);
    expect(revokes.some((u) => u.includes("/revoke"))).toBe(true);
  });
});

describe("Offline WEB pack (#142)", () => {
  it("pins eBible.org engwebp by SHA-256", () => {
    expect(WEB_PACK_PIN.url).toBe("https://ebible.org/Scriptures/engwebp_vpl.zip");
    expect(WEB_PACK_PIN.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("verifies checksums", () => {
    const buf = fs.readFileSync(FIXTURE);
    expect(sha256Hex(buf)).toBe(FIXTURE_SHA);
    expect(verifySha256(buf, FIXTURE_SHA)).toBe(true);
    expect(verifySha256(buf, FIXTURE_SHA.toUpperCase())).toBe(true);
    expect(verifySha256(Buffer.concat([buf, Buffer.from("x")]), FIXTURE_SHA)).toBe(false);
    expect(verifySha256(buf, "nope")).toBe(false);
  });
  it("parses VPL and looks up ranges", () => {
    const pack = parseVpl(unzipEntry(fs.readFileSync(FIXTURE), "engwebp_vpl.txt").toString("utf8"), { source: "t", version: "t", translation: "WEB" });
    const ref = (s: string) => {
      const p = parseScriptureRef(s);
      if (!p.ok) throw new Error(s);
      return p.ref;
    };
    expect(lookupPassage(pack, ref("John 3:16")).verses.map((v) => v.verse)).toEqual([16]);
    expect(lookupPassage(pack, ref("Jn 15:1-3")).verses.map((v) => v.verse)).toEqual([1, 2, 3]);
    expect(lookupPassage(pack, ref("John 15")).verses).toHaveLength(5);
    expect(lookupPassage(pack, ref("Ps 23")).verses[0].text).toMatch(/shepherd/);
    expect(lookupPassage(pack, ref("Rev 1:1")).verses[0].text).toBe("Fixture verse for REV.");
    expect(() => parseVpl("GEN 1:1 x", { source: "t", version: "t", translation: "WEB" })).toThrow(/66 books/);
  });
  it("refuses a download whose checksum doesn't match; installs and serves verses when it does", async () => {
    const zip = fs.readFileSync(FIXTURE);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(zip, { status: 200 })),
    );
    process.env.JARVIS_BIBLE_PACK_URL = "http://mock.test/engwebp_vpl.zip";
    process.env.JARVIS_BIBLE_PACK_SHA256 = "0".repeat(64);
    await expect(installPack()).rejects.toThrow(/pinned checksum/);
    expect(fs.existsSync(path.join(dataDir, "bible"))).toBe(false);
    expect(loadPack()).toBeNull();
    await json(call(passageRoute.GET, { url: "http://jarvis.test/api/bible/passage?ref=John%203:16" }), 404);

    process.env.JARVIS_BIBLE_PACK_SHA256 = FIXTURE_SHA;
    const st = await json<{ installed: boolean }>(call(bibleRoute.POST, { method: "POST", body: { confirm: true } }));
    expect(st.installed).toBe(true);
    const p = await json<{ ref: string; translation: string; verses: { text: string }[]; attribution: string }>(
      call(passageRoute.GET, { url: "http://jarvis.test/api/bible/passage?ref=Jn%203%2016" }),
    );
    expect(p.ref).toBe("John 3:16");
    expect(p.translation).toBe("WEB");
    expect(p.verses[0].text).toMatch(/^For God so loved the world/);
    expect(p.attribution).toMatch(/public domain/);

    // tampering with the stored pack is caught before use
    fs.appendFileSync(path.join(dataDir, "bible", "web.json"), " ");
    __forgetLoadedPack();
    await json(call(passageRoute.GET, { url: "http://jarvis.test/api/bible/passage?ref=John%203:16" }), 409);
    await json(call(bibleRoute.POST, { method: "POST", body: { confirm: true } }));
    await json(call(passageRoute.GET, { url: "http://jarvis.test/api/bible/passage?ref=John%203:16" }));
    await json(call(bibleRoute.DELETE, { method: "DELETE" }));
    expect(fs.existsSync(path.join(dataDir, "bible"))).toBe(false);
  });
});
