import "server-only";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { getDb, schema } from "@/server/db";
import { audit } from "@/server/audit";
import { HttpError } from "@/server/http/errors";
import { webhookSecret } from "./github-connections";
import { DELIVERY_RETENTION_MS, linkKey, parseWebhookEvent, verifySignature, WEBHOOK_MAX_BYTES, type IssueEvent } from "./github-rules";
import { fetchChecksState, fetchPullHead, storedConnections } from "./github";
import { appAllowlist, applyInstallationEvent, appWebhookSecret, storedApp } from "./github-app";
import { accountAllowed, deliveryAccount, parseChecksEvent, parseInstallationEvent, type ChecksEvent } from "./github-app-rules";
import { applyIssueAssignment } from "./inbox";
import { applyLinkState } from "./store";

/**
 * Read-only GitHub webhooks (POST /api/work/github/webhook; docs/work.md).
 * Public (GitHub has no session) and CSRF-exempt, so the only credential is
 * the HMAC: X-Hub-Signature-256 over the raw body with the GitHub App's
 * webhook secret or the legacy secret from Settings → Connections → GitHub,
 * compared in constant time. Bodies over 1 MB are refused. Each
 * X-GitHub-Delivery is handled once. App deliveries for accounts outside the
 * App allowlist are ignored. `pull_request`, `pull_request_review` and
 * `issues` change only PRs/issues already linked to Work items (plus
 * assigned-issue intake); `check_suite`/`workflow_run` update linked PRs' CI
 * state; `installation`/`installation_repositories` keep the App's
 * installation list current. Nothing is ever written to GitHub.
 */

const json = (status: number, body: unknown) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

async function rawBody(req: NextRequest) {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > WEBHOOK_MAX_BYTES) throw new HttpError(413, "too_large", "Payload too large");
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length > WEBHOOK_MAX_BYTES) throw new HttpError(413, "too_large", "Payload too large");
  return buf;
}

/** Remember a delivery id; false when it was already handled (GitHub redelivers). */
function claimDelivery(id: string, event: string, now: Date) {
  const D = schema.workGithubDeliveries;
  const db = getDb();
  db.delete(D)
    .where(lt(D.receivedAt, new Date(now.getTime() - DELIVERY_RETENTION_MS).toISOString()))
    .run();
  return db.insert(D).values({ id, event, receivedAt: now.toISOString() }).onConflictDoNothing().run().changes === 1;
}

function linksFor(kind: "github_pr" | "github_issue", key: string) {
  const L = schema.workLinks;
  const T = schema.workItems;
  return getDb()
    .select({ link: L, owner: T.userId })
    .from(L)
    .innerJoin(T, eq(T.id, L.itemId))
    .where(and(eq(L.kind, kind), sql`lower(${L.targetId}) = ${key}`))
    .all();
}

function issueIntake(ev: IssueEvent) {
  let n = 0;
  if (!ev.nodeId || !ev.url) return n;
  for (const c of storedConnections()) {
    if (c.ownerKey !== ev.owner.toLowerCase()) continue;
    if (c.repos.length && !c.repos.some((r) => r.toLowerCase() === ev.repo.toLowerCase())) continue;
    if (!c.login) continue; // the token's login is learned by Test or the poller
    const assigned = ev.assignees.includes(c.login.toLowerCase());
    applyIssueAssignment(
      c.createdBy,
      c.id,
      { nodeId: ev.nodeId, title: ev.title, url: ev.url, repo: `${ev.owner}/${ev.repo}`, owner: ev.owner, number: ev.number },
      assigned,
      ev.state === "open",
      c.owner,
    );
    n++;
  }
  return n;
}

/** CI state for linked PRs: the combined state of the head commit when it can be read (GETs only), else the event's own. */
async function applyChecks(ev: ChecksEvent, now: Date) {
  let linked = 0;
  let changed = 0;
  let stale = 0;
  const byHead = new Map<string, Awaited<ReturnType<typeof fetchChecksState>>>();
  for (const n of ev.prNumbers) {
    const links = linksFor("github_pr", linkKey({ owner: ev.owner, repo: ev.repo, number: n }));
    if (!links.length) continue;
    // Only the PR's current head decides its badge: an older commit's run finishing late must not overwrite it.
    // When the head can't be read (no token covers the repo) the signed event is the only signal, so its own state is used.
    const head = await fetchPullHead({ owner: ev.owner, repo: ev.repo, number: n });
    let state: Awaited<ReturnType<typeof fetchChecksState>>;
    if (!head) state = ev.state;
    else if (ev.sha && ev.sha.toLowerCase() !== head.toLowerCase()) state = null;
    else {
      if (!byHead.has(head)) byHead.set(head, await fetchChecksState(ev, head));
      state = byHead.get(head) ?? ev.state;
    }
    if (!state) {
      stale++;
      continue;
    }
    for (const { link } of links) {
      linked++;
      if (link.checksState !== state) changed++;
      getDb().update(schema.workLinks).set({ checksState: state, checksAt: now.toISOString() }).where(eq(schema.workLinks.id, link.id)).run();
    }
  }
  return { linked, changed, stale };
}

function finish(delivery: string, event: string, correlationId: string, outcome: string, detail: Record<string, unknown>, result: "ok" | "rejected" = "ok") {
  getDb().update(schema.workGithubDeliveries).set({ outcome }).where(eq(schema.workGithubDeliveries.id, delivery)).run();
  audit({ actor: "github", action: "work.github_webhook", source: "github", sourceRecord: delivery, result, correlationId, detail: { event, ...detail } });
}

export async function handleGithubWebhook(req: NextRequest, correlationId: string, now = new Date()) {
  const body = await rawBody(req);
  const sig = req.headers.get("x-hub-signature-256");
  const appSecret = appWebhookSecret();
  const legacySecret = webhookSecret();
  // Without a secret nothing can be verified, so nothing is accepted.
  const via = appSecret && verifySignature(appSecret, body, sig) ? "app" : legacySecret && verifySignature(legacySecret, body, sig) ? "legacy" : null;
  if (!via) return json(401, { error: "Bad signature", code: "signature" });
  const delivery = req.headers.get("x-github-delivery")?.trim() ?? "";
  const event = req.headers.get("x-github-event")?.trim() ?? "";
  if (!/^[A-Za-z0-9-]{1,100}$/.test(delivery) || !/^[a-z_]{1,50}$/.test(event)) return json(400, { error: "Missing delivery headers", code: "headers" });
  if (!claimDelivery(delivery, event, now)) return json(200, { ok: true, duplicate: true });
  if (event === "ping") return json(200, { ok: true, event });
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    return json(400, { error: "Body must be JSON", code: "bad_json" });
  }

  // GitHub App lifecycle: keep the installation list (and token cache) current.
  if (event === "installation" || event === "installation_repositories") {
    const inst = parseInstallationEvent(event, payload);
    if (!inst || via !== "app") return json(202, { ok: true, ignored: event });
    const r = applyInstallationEvent(inst);
    finish(delivery, event, correlationId, `installation ${inst.action} (${inst.account}${r.allowed ? "" : ", not allowlisted"})`, {
      installation: inst.id,
      account: inst.account,
      action: inst.action,
      allowed: r.allowed,
    });
    return json(200, { ok: true, event, installation: inst.id, allowed: r.allowed });
  }

  // App deliveries for accounts outside the allowlist are ignored (and flagged in the audit log).
  const who = deliveryAccount(payload);
  const app = who ? storedApp() : null;
  if (who && app && !accountAllowed(appAllowlist(app).list, who.account)) {
    finish(
      delivery,
      event,
      correlationId,
      `ignored: ${who.account ?? "unknown account"} not allowlisted`,
      { installation: who.installationId, account: who.account },
      "rejected",
    );
    return json(202, { ok: true, ignored: event, reason: "installation_not_allowed" });
  }

  if (event === "check_suite" || event === "workflow_run") {
    const ce = parseChecksEvent(event, payload);
    if (!ce) return json(202, { ok: true, ignored: event });
    const r = await applyChecks(ce, now);
    finish(delivery, event, correlationId, `${r.linked} linked, ${r.changed} checks changed, ${r.stale} stale`, {
      linked: r.linked,
      checksChanged: r.changed,
      stale: r.stale,
      state: ce.state,
    });
    return json(200, { ok: true, event, linked: r.linked, changed: r.changed, stale: r.stale });
  }

  const ev = parseWebhookEvent(event, payload);
  if (!ev) return json(202, { ok: true, ignored: event });

  let updated = 0;
  const kind = ev.kind === "pull" ? "github_pr" : "github_issue";
  const links = linksFor(kind, linkKey(ev));
  for (const { link, owner } of links) {
    const after = applyLinkState(owner, "github", link.id, ev.state, correlationId, "github");
    if (after.externalState !== link.externalState) updated++;
  }
  if (links.length)
    getDb()
      .update(schema.workLinks)
      .set({ checkedAt: now.toISOString(), checkError: null })
      .where(
        inArray(
          schema.workLinks.id,
          links.map((l) => l.link.id),
        ),
      )
      .run();
  const intake = ev.kind === "issue" ? issueIntake(ev) : 0;
  finish(delivery, event, correlationId, `${links.length} linked, ${updated} changed, ${intake} intake`, { linked: links.length, changed: updated, intake });
  return json(200, { ok: true, event, linked: links.length, changed: updated, intake });
}
