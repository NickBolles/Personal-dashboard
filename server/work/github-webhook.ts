import "server-only";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { getDb, schema } from "@/server/db";
import { audit } from "@/server/audit";
import { HttpError } from "@/server/http/errors";
import { webhookSecret } from "./github-connections";
import { DELIVERY_RETENTION_MS, linkKey, parseWebhookEvent, verifySignature, WEBHOOK_MAX_BYTES, type IssueEvent } from "./github-rules";
import { storedConnections } from "./github";
import { applyIssueAssignment } from "./inbox";
import { applyLinkState } from "./store";

/**
 * Read-only GitHub webhooks (POST /api/work/github/webhook; docs/work.md).
 * Public (GitHub has no session) and CSRF-exempt, so the only credential is
 * the HMAC: X-Hub-Signature-256 over the raw body with the secret from
 * Settings → Connections → GitHub, compared in constant time. Bodies over
 * 1 MB are refused. Each X-GitHub-Delivery is handled once. Only
 * `pull_request` and `issues` events change anything, and only for PRs/issues
 * already linked to Work items (plus assigned-issue intake into the inbox).
 * Nothing is ever written to GitHub; Jarvis never registers the webhook.
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

export async function handleGithubWebhook(req: NextRequest, correlationId: string, now = new Date()) {
  const body = await rawBody(req);
  const secret = webhookSecret();
  // Without a secret nothing can be verified, so nothing is accepted.
  if (!secret || !verifySignature(secret, body, req.headers.get("x-hub-signature-256"))) return json(401, { error: "Bad signature", code: "signature" });
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
  getDb()
    .update(schema.workGithubDeliveries)
    .set({ outcome: `${links.length} linked, ${updated} changed, ${intake} intake` })
    .where(eq(schema.workGithubDeliveries.id, delivery))
    .run();
  audit({
    actor: "github",
    action: "work.github_webhook",
    source: "github",
    sourceRecord: delivery,
    result: "ok",
    correlationId,
    detail: { event, linked: links.length, changed: updated, intake },
  });
  return json(200, { ok: true, event, linked: links.length, changed: updated, intake });
}
