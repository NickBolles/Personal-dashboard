#!/usr/bin/env node
/**
 * UX screenshot harness for the Chief of staff panel and chat, against a running Jarvis
 * (the local demo by default; seed it first with scripts/demo-seed-coordinator.mjs).
 *
 *   node scripts/ux-shots.mjs [--label before] [--out <dir>] [--only phone,desktop] [--seed] [--headed] [--touch]
 *
 *   --label <name>   names the default output folder: test-results/ux-shots/<label> (default "current")
 *   --out <dir>      output folder (overrides --label)
 *   --only <list>    viewports to run: cover, unfolded (Z Fold 6 closed / open), phone, small, desktop (default: all)
 *   --seed           run scripts/demo-seed-coordinator.mjs first (fresh ages, unread state and refs)
 *   --headed         show the browser
 *   --touch          let the page record "last looked" / "read" markers. By default those two POSTs are
 *                    answered locally, so taking shots never changes what the next run (or viewport) sees.
 *
 * Env: JARVIS_URL (http://localhost:3000), JARVIS_PASSCODE (default: PASSCODE in e2e/helpers.ts),
 *      UX_SHOTS_BROWSER (path to a Chromium/Chrome/Edge binary, if Playwright's own is not installed).
 *
 * Output: <out>/<viewport>-<nn>-<slug>.png and <out>/report.json. Per shot the report has the URL, the
 * viewport, horizontal overflow of the document and of every scroll container inside the open Chief of
 * staff sheet / rail, that panel's visible text (4000 chars) and any console errors: interaction evidence
 * for reviewers. A step that fails is logged and recorded; the run continues.
 *
 * Tabs are found by role=tab and files are named from the tab label, so renamed or merged tabs still work.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { chromium, request } = createRequire(path.join(ROOT, "package.json"))("@playwright/test");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined);
if (flag("help") || flag("h")) {
  console.log(
    fs
      .readFileSync(fileURLToPath(import.meta.url), "utf8")
      .split("*/")[0]
      .replace(/^#!.*\n/, ""),
  );
  process.exit(0);
}
const BASE = (process.env.JARVIS_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const LABEL = option("label") ?? "current";
const OUT = path.resolve(ROOT, option("out") ?? path.join("test-results", "ux-shots", LABEL));
const ONLY = option("only")
  ?.split(",")
  .map((s) => s.trim());
const PANEL_NAME = "Chief of staff";

const VIEWPORTS = [
  // The owner’s device: a Galaxy Z Fold 6 at normal zoom, closed (cover screen) and unfolded.
  { name: "cover", viewport: { width: 368, height: 850 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.5 },
  { name: "unfolded", viewport: { width: 706, height: 822 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.5 },
  { name: "phone", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { name: "small", viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { name: "desktop", viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
].filter((v) => !ONLY || ONLY.includes(v.name));

const log = (...a) => console.log("[shots]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "untitled";

/** Other Chromium builds already in Playwright's browser folder (newest first), then the system Chrome / Edge. */
function otherBrowsers() {
  const options = [];
  try {
    const registry = path.resolve(chromium.executablePath(), "..", "..", "..");
    const builds = fs
      .readdirSync(registry)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const build of builds) {
      for (const dir of fs.readdirSync(path.join(registry, build))) {
        const exe = path.join(registry, build, dir, process.platform === "win32" ? "chrome.exe" : "chrome");
        if (fs.existsSync(exe)) options.push({ name: build, launch: { executablePath: exe } });
      }
    }
  } catch {
    /* no registry folder */
  }
  return [...options, { name: "system Chrome", launch: { channel: "chrome" } }, { name: "system Edge", launch: { channel: "msedge" } }];
}

/**
 * Playwright's own Chromium may still be downloading (`npx playwright install chromium`). Never start a
 * second install: use another Chromium that is already on this machine, else wait for the download.
 */
async function launch() {
  const headless = !flag("headed");
  if (process.env.UX_SHOTS_BROWSER) return chromium.launch({ headless, executablePath: process.env.UX_SHOTS_BROWSER });
  let last;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      return await chromium.launch({ headless });
    } catch (err) {
      last = err;
      if (!/Executable doesn't exist/.test(String(err.message))) break;
    }
    if (attempt === 0) {
      for (const other of otherBrowsers()) {
        try {
          const browser = await chromium.launch({ headless, ...other.launch });
          log(`Playwright's Chromium is not installed (yet); using ${other.name}`);
          return browser;
        } catch {
          /* try the next one */
        }
      }
      log("no Chromium on this machine yet; waiting for the Playwright download to finish (up to 5 min)…");
    }
    await sleep(10_000);
  }
  throw last;
}

async function signIn() {
  const passcode =
    process.env.JARVIS_PASSCODE ?? fs.readFileSync(path.join(ROOT, "e2e/helpers.ts"), "utf8").match(/export const PASSCODE\s*=\s*"([^"]+)"/)?.[1];
  if (!passcode) throw new Error("No passcode: set JARVIS_PASSCODE");
  const api = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-jarvis-csrf": "1", origin: BASE } });
  const res = await api.post("/api/auth/login", { data: { passcode } });
  if (!res.ok()) throw new Error(`Sign-in failed (${res.status()}): is Jarvis running and onboarded at ${BASE}?`);
  return api;
}

/** What to open: found through the same GET APIs the UI uses, so nothing here depends on seeded ids. */
async function targets(api) {
  const get = async (route) => {
    const res = await api.get(route);
    return res.ok() ? res.json() : null;
  };
  const decisions = (await get("/api/coordinator/decisions"))?.decisions ?? [];
  const sessions = (await get("/api/hermes/sessions"))?.sessions ?? [];
  const longest = [...decisions].sort((a, b) => b.question.length - a.question.length)[0];
  const risky = decisions.find((d) => d.risk?.length && d.pack?.options?.length) ?? decisions.find((d) => d.risk?.length);
  return {
    looked: (await get("/api/coordinator/looked")) ?? { lastLooked: {} },
    longDecision: longest?.question.length > 200 ? longest.ref : null,
    riskyDecision: risky?.ref ?? null,
    evals: sessions.find((s) => /weekly eval review/i.test(s.title)) ?? null,
    emptyCoordinator: sessions.find((s) => /coordinator/i.test(s.title) && !s.messageCount) ?? null,
    toolSteps: sessions.find((s) => s.activeRun) ?? sessions.find((s) => /preview|tool/i.test(s.title)) ?? null,
  };
}

/** Runs in the page: overflow of the document and of the open panel's scroll containers, plus the panel text. */
function measure(panelName) {
  const doc = document.documentElement;
  const panel =
    document.querySelector("dialog[open]") ??
    document.querySelector(`aside[aria-label="${panelName}"], [role="complementary"][aria-label="${panelName}"], [data-testid="gc-rail"]`);
  const describe = (el) =>
    `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}` : ""}`;
  const containers = [];
  if (panel) {
    for (const el of [panel, ...panel.querySelectorAll("*")]) {
      const style = getComputedStyle(el);
      const x = /(auto|scroll)/.test(style.overflowX);
      const y = /(auto|scroll)/.test(style.overflowY);
      if (!(x || y || el === panel || el.getAttribute("role") === "tabpanel") || el.clientWidth === 0) continue;
      // A "strip" is a short block that scrolls sideways on its own (a chip row, a code block): reported, but not
      // counted as overflow. (overflow-y computes to auto whenever overflow-x is set, so the test is by shape.)
      const lone =
        x && el !== panel && el.getAttribute("role") !== "tabpanel" && el.scrollHeight <= el.clientHeight + 1 && el.clientHeight < panel.clientHeight * 0.4;
      const strip = el.hasAttribute("data-scroll-x") || lone;
      const overflow = el.scrollWidth > el.clientWidth + 1;
      containers.push({ el: describe(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, overflow, ...(strip ? { strip } : {}) });
    }
  }
  return {
    document: { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, overflow: doc.scrollWidth > doc.clientWidth },
    panel: panel
      ? {
          found: describe(panel),
          overflow: containers.some((c) => c.overflow && !c.strip),
          containers: containers.filter((c) => c.overflow).concat(containers.filter((c) => !c.overflow).slice(0, 6)),
          text: panel.innerText.slice(0, 4000),
        }
      : null,
  };
}

async function runViewport(browser, vp, storageState, t, report) {
  const context = await browser.newContext({
    baseURL: BASE,
    storageState,
    viewport: vp.viewport,
    isMobile: vp.isMobile,
    hasTouch: vp.hasTouch,
    deviceScaleFactor: vp.deviceScaleFactor,
    reducedMotion: "reduce",
    locale: "en-US",
  });
  // The Next.js dev indicator is not part of the product.
  await context.addInitScript(() => {
    const hide = () => document.head?.appendChild(Object.assign(document.createElement("style"), { textContent: "nextjs-portal{display:none!important}" }));
    if (document.head) hide();
    else document.addEventListener("DOMContentLoaded", hide);
  });
  if (!flag("touch")) {
    // Looking must not change the data: answer the two "I saw this" writes locally.
    await context.route("**/api/coordinator/looked", (route) => (route.request().method() === "POST" ? route.fulfill({ json: t.looked }) : route.continue()));
    await context.route("**/api/work/conversations/read", (route) =>
      route.request().method() === "POST" ? route.fulfill({ json: { readAt: new Date().toISOString() } }) : route.continue(),
    );
  }
  const page = await context.newPage();
  let errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 300)));
  page.on("pageerror", (e) => errors.push(`pageerror: ${String(e.message).slice(0, 300)}`));

  const tap = (locator) => (vp.hasTouch ? locator.tap({ timeout: 8000 }) : locator.click({ timeout: 8000 }));
  const settle = async (ms = 500) => {
    await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {}); // chats with a live run keep a stream open
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    await sleep(ms);
  };
  const open = async (route) => {
    await page.goto(route, { waitUntil: "domcontentloaded" });
    await settle(700);
  };
  let n = 0;
  const shot = async (slug, note) => {
    const file = `${vp.name}-${String(++n).padStart(2, "0")}-${slugify(slug)}.png`;
    const entry = { file, step: slug, viewport: { name: vp.name, ...vp.viewport, deviceScaleFactor: vp.deviceScaleFactor }, url: page.url().replace(BASE, "") };
    try {
      await page.screenshot({ path: path.join(OUT, file), animations: "disabled", caret: "hide" });
      Object.assign(entry, { overflow: await page.evaluate(measure, PANEL_NAME) });
    } catch (err) {
      entry.error = String(err.message).split("\n")[0];
    }
    if (note) entry.note = note;
    if (errors.length) entry.consoleErrors = errors.slice(0, 8);
    errors = [];
    report.shots.push(entry);
    const o = entry.overflow;
    log(
      `  ${file}${o?.document.overflow ? "  [page overflows sideways]" : ""}${o?.panel?.overflow ? "  [panel overflows sideways]" : ""}${entry.error ? `  [${entry.error}]` : ""}`,
    );
  };
  /** One named step; a failure is recorded and the run goes on. */
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (err) {
      const message = String(err.message).split("\n")[0];
      log(`  ! ${vp.name}: ${name} failed: ${message}`);
      report.failures.push({ viewport: vp.name, step: name, error: message });
    }
  };

  const panel = () => (vp.viewport.width >= 900 ? page.getByRole("complementary", { name: PANEL_NAME }) : page.getByRole("dialog", { name: PANEL_NAME }));
  const openPanel = async () => {
    if (vp.viewport.width >= 900) {
      const expand = page.getByRole("button", { name: `Expand ${PANEL_NAME}` });
      if (await expand.isVisible().catch(() => false)) await tap(expand);
    } else {
      // The tray's main button; its accessible name is the panel name.
      await tap(
        page
          .locator(".gc-tray-main")
          .or(page.getByRole("button", { name: PANEL_NAME, exact: true }))
          .first(),
      );
    }
    await panel().waitFor({ state: "visible", timeout: 8000 });
    await settle(400);
  };
  const backToList = async () => {
    const back = panel()
      .getByRole("button", { name: /^Back to / })
      .first();
    if (await back.isVisible().catch(() => false)) {
      await tap(back);
      await settle(250);
    }
  };
  const decisionDetail = async (ref, slug, tabLabel) => {
    if (!ref) return report.failures.push({ viewport: vp.name, step: slug, error: "no matching decision in /api/coordinator/decisions" });
    await step(slug, async () => {
      await backToList();
      const row = panel()
        .getByRole("button", { name: new RegExp(`^Open decision ${ref}\\b`) })
        .first();
      if (await row.count()) await tap(row);
      else {
        // The list markup changed: use the notification deep link, which opens the panel on that decision.
        await open(`/home?coord=needs&d=${ref}`);
        await panel().waitFor({ state: "visible", timeout: 8000 });
      }
      await settle(400);
      await shot(slug, `${tabLabel} → ${ref}`);
      await otherEnd(slug, `${tabLabel} → ${ref}, scrolled to the other end (the answers)`);
    });
  };
  /** When the open panel scrolls, a second shot from the other end of it (a thread's start, a list's tail). */
  const otherEnd = async (slug, note) => {
    const moved = await panel().evaluate((el) => {
      let any = false;
      for (const node of [el, ...el.querySelectorAll("*")]) {
        if (node.scrollHeight <= node.clientHeight + 40 || !/(auto|scroll)/.test(getComputedStyle(node).overflowY)) continue;
        node.scrollTop = node.scrollTop > 20 ? 0 : node.scrollHeight;
        any = true;
      }
      return any;
    });
    if (!moved) return;
    await sleep(250);
    await shot(`${slug}-scrolled`, note);
  };

  log(`${vp.name} ${vp.viewport.width}x${vp.viewport.height}`);
  await step("home", async () => {
    await open("/home");
    await shot("home", "top of the page; the tray (phone) or rail (desktop) as it loads");
  });

  await step("chief of staff", async () => {
    await openPanel();
    await shot("cos-opened", vp.viewport.width >= 900 ? "right rail, expanded" : "after tapping the tray's main button");
    let tabs = panel().getByRole("tab");
    if (!(await tabs.count())) {
      // The tap opened a card instead of the tabs: use the deep link to the chat tab.
      await open("/home?coord=chat");
      await panel().waitFor({ state: "visible", timeout: 8000 });
      tabs = panel().getByRole("tab");
    }
    const labels = (await tabs.allInnerTexts()).map((s) => s.replace(/\s+/g, " ").trim());
    report.tabs[vp.name] = labels;
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i].replace(/\s*\d+$/, "") || `tab ${i + 1}`;
      const slug = `cos-${slugify(label)}`;
      await step(slug, async () => {
        // Re-open if an earlier step navigated away (the phone sheet closes on navigation).
        if (
          !(await panel()
            .isVisible()
            .catch(() => false))
        ) {
          await open("/home");
          await openPanel();
        }
        await tap(panel().getByRole("tab").nth(i));
        await settle(500);
        if (/needs|decision/i.test(label)) await backToList();
        await shot(slug, `tab "${labels[i]}"`);
        await otherEnd(slug, `tab "${labels[i]}", scrolled to the other end`);
        // Whichever tab lists runs (data-run-ref rows): open one so its event log shows.
        await step(`${slug}-run-log`, async () => {
          const rows = panel().locator("[data-run-ref]");
          if (!(await rows.count())) return;
          const closed = rows.locator('button[aria-expanded="false"]').first();
          const toggle = (await closed.count()) ? closed : rows.locator("button").first();
          await toggle.scrollIntoViewIfNeeded();
          await tap(toggle);
          await settle(400);
          await shot(`${slug}-run-log`, "a run row opened to show its event log");
        });
      });
      if (/needs|decision/i.test(label)) {
        await decisionDetail(t.longDecision, `${slug}-detail-long-question`, label);
        await decisionDetail(t.riskyDecision, `${slug}-detail-risk-flagged`, label);
      }
    }
  });

  const scrollChat = (toEnd) =>
    page.evaluate((end) => {
      const all = [document.scrollingElement, ...document.querySelectorAll("main *, main")].filter(Boolean);
      for (const el of all) {
        if (el.scrollHeight > el.clientHeight + 40 && (el === document.scrollingElement || /(auto|scroll)/.test(getComputedStyle(el).overflowY)))
          el.scrollTop = end ? el.scrollHeight : 0;
      }
    }, toEnd);
  const chat = async (session, slug, note, { both = false } = {}) => {
    if (!session) return report.failures.push({ viewport: vp.name, step: slug, error: "no matching conversation in /api/hermes/sessions" });
    await step(slug, async () => {
      await open(`/chat/${encodeURIComponent(session.id)}`);
      await page
        .getByLabel("Conversation timeline")
        .waitFor({ state: "visible", timeout: 10_000 })
        .catch(() => {});
      await settle(600);
      if (both) {
        await scrollChat(false);
        await sleep(250);
        await shot(`${slug}-top`, `${note} (top of the thread)`);
      }
      await scrollChat(true);
      await sleep(250);
      await shot(both ? `${slug}-bottom` : slug, `${note}${both ? " (bottom of the thread and the composer)" : ""}`);
    });
  };
  await step("chat list", async () => {
    await open("/chat");
    await shot("chat-list", "conversation list");
  });
  await chat(t.evals, "chat-weekly-eval-review", `"${t.evals?.title}": long markdown answer`, { both: true });
  await chat(t.emptyCoordinator, "chat-empty-coordinator", `"${t.emptyCoordinator?.title}": no messages yet`);
  await chat(
    t.toolSteps,
    "chat-tool-steps-approval",
    `"${t.toolSteps?.title}": tool steps${t.toolSteps?.activeRun ? `, active run ${t.toolSteps.activeRun.status}` : ""}`,
  );
  await context.close();
}

async function main() {
  if (flag("seed")) {
    log("seeding first (scripts/demo-seed-coordinator.mjs)");
    const seeded = spawnSync(process.execPath, [path.join(ROOT, "scripts", "demo-seed-coordinator.mjs")], { stdio: "inherit", env: process.env });
    if (seeded.status !== 0) log("the seed reported problems; taking shots anyway");
  }
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT)) if (/\.png$|^report\.json$/.test(f)) fs.rmSync(path.join(OUT, f));
  const api = await signIn();
  const storageState = await api.storageState();
  const t = await targets(api);
  await api.dispose();
  const browser = await launch();
  const report = {
    label: LABEL,
    base: BASE,
    takenAt: new Date().toISOString(),
    browser: browser.version(),
    targets: { ...t, looked: undefined },
    tabs: {},
    shots: [],
    failures: [],
  };
  try {
    for (const vp of VIEWPORTS) await runViewport(browser, vp, storageState, t, report);
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  }
  const sideways = report.shots.filter((s) => s.overflow?.document.overflow || s.overflow?.panel?.overflow);
  log(
    `${report.shots.length} shots in ${path.relative(ROOT, OUT) || OUT}; ${report.failures.length} failed step(s); ${sideways.length} shot(s) with horizontal overflow`,
  );
  for (const s of sideways) log(`  overflow: ${s.file}`);
  for (const f of report.failures) log(`  failed: ${f.viewport} ${f.step}: ${f.error}`);
}

main().catch((err) => {
  console.error(`[shots] failed: ${err.message}`);
  process.exitCode = 1;
});
