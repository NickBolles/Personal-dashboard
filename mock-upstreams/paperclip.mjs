// Mock Paperclip API (paperclipai/paperclip @ f38b5693 contracts).
import { randomUUID } from "node:crypto";
import { json, readBody, bearerOk, notFound } from "./util.mjs";

const COMPANY = "5b0c8a2e-6a0f-4b8e-9d3c-1f2a3b4c5d6e";
const PROJECT = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

export function createPaperclip({ apiKey }) {
  const state = { issues: new Map(), idem: new Map(), comments: [], counter: 230 };

  function add(p) {
    const issueNumber = ++state.counter;
    const issue = {
      id: p.id ?? randomUUID(),
      companyId: COMPANY,
      projectId: p.projectId ?? PROJECT,
      goalId: null,
      parentId: p.parentId ?? null,
      title: p.title,
      description: p.description ?? null,
      status: p.status ?? "backlog",
      priority: p.priority ?? "medium",
      assigneeAgentId: p.assigneeAgentId ?? null,
      assigneeUserId: p.assigneeUserId ?? null,
      issueNumber,
      identifier: `PAP-${issueNumber}`,
      labelIds: [],
      labels: [],
      blockedByIds: p.blockedByIds ?? [],
      startedAt: null,
      completedAt: p.status === "done" ? new Date().toISOString() : null,
      cancelledAt: null,
      createdAt: new Date(Date.now() - 86400000 * 2).toISOString(),
      updatedAt: new Date().toISOString(),
    };
    state.issues.set(issue.id, issue);
    return issue;
  }

  function summary(i) {
    return { id: i.id, identifier: i.identifier, title: i.title, status: i.status, priority: i.priority, assigneeAgentId: i.assigneeAgentId, assigneeUserId: i.assigneeUserId };
  }
  function withRelations(i) {
    const blockedBy = i.blockedByIds.map((id) => state.issues.get(id)).filter(Boolean).map(summary);
    const blocks = [...state.issues.values()].filter((x) => x.blockedByIds.includes(i.id)).map(summary);
    const { blockedByIds, ...rest } = i;
    return { ...rest, blockedBy, blocks };
  }

  function seed() {
    state.issues.clear();
    state.idem.clear();
    state.counter = 199;
    const parent = add({ title: "Enable v5 across the platform", status: "in_progress", priority: "high", assigneeUserId: "user_nick" });
    state.counter = 219;
    const audit = add({ title: "Compatibility audit", parentId: parent.id, status: "done", assigneeAgentId: "agent_cto" });
    const decide = add({ title: "Decide config token storage", parentId: parent.id, status: "in_review", assigneeUserId: "user_nick" });
    add({ title: "Configuration migration", parentId: parent.id, status: "blocked", assigneeAgentId: "agent_eng", blockedByIds: [decide.id] });
    add({ title: "Rollout", parentId: parent.id, status: "todo", assigneeAgentId: "agent_eng" });
    add({ title: "Documentation", parentId: parent.id, status: "backlog" });
    add({ title: "Verification and rollback plan", parentId: parent.id, status: "todo", assigneeAgentId: "agent_qa" });
    void audit;
    add({ title: "Household budget automation", status: "todo", priority: "medium", assigneeUserId: "user_nick" });
  }
  seed();

  async function handle(req, res, path, url, control) {
    if (path === "/api/health") return json(res, 200, { status: "ok" });
    if (control.fail.has("paperclip")) return json(res, 503, { error: "unavailable" });
    if (!bearerOk(req, apiKey)) return json(res, 401, { error: "Agent token did not verify; obtain fresh credentials and retry" });
    const m = req.method;
    let match;
    if (path === "/api/cli-auth/me") return json(res, 200, { user: { id: "user_nick", name: "Nick" }, userId: "user_nick", companyIds: [COMPANY], source: "board_key" });
    if (path === "/api/companies") {
      return json(res, 200, [{ id: COMPANY, name: "Bolles HQ", status: "active", issuePrefix: "PAP", issueCounter: state.counter, createdAt: "2026-06-01T12:00:00.000Z", updatedAt: new Date().toISOString() }]);
    }
    if ((match = path.match(/^\/api\/companies\/([^/]+)\/projects$/))) {
      return json(res, 200, [{ id: PROJECT, companyId: COMPANY, urlKey: "platform", name: "Platform", status: "in_progress", taskCount: state.issues.size, createdAt: "2026-07-01T00:00:00.000Z", updatedAt: new Date().toISOString() }]);
    }
    if ((match = path.match(/^\/api\/companies\/([^/]+)\/issues$/)) && m === "GET") {
      let list = [...state.issues.values()];
      const status = url.searchParams.get("status");
      if (status) list = list.filter((i) => status.split(",").includes(i.status));
      const parentId = url.searchParams.get("parentId");
      if (parentId) list = list.filter((i) => i.parentId === (parentId === "null" ? null : parentId));
      const q = url.searchParams.get("q");
      if (q) list = list.filter((i) => `${i.title} ${i.identifier}`.toLowerCase().includes(q.toLowerCase()));
      if (url.searchParams.get("assigneeUserId") === "me") list = list.filter((i) => i.assigneeUserId === "user_nick");
      return json(res, 200, list.map(withRelations));
    }
    if ((match = path.match(/^\/api\/companies\/([^/]+)\/issues$/)) && m === "POST") {
      const body = await readBody(req);
      if (!body.title) return json(res, 400, { error: "title is required" });
      if (body.parentId && !/^[0-9a-f-]{36}$/.test(body.parentId)) return json(res, 400, { error: "parentId must be a uuid" });
      if (body.idempotencyKey && state.idem.has(body.idempotencyKey)) {
        const existing = state.issues.get(state.idem.get(body.idempotencyKey));
        return json(res, 200, { ...withRelations(existing), deduplicated: true, deduplicationReason: "idempotency_key" });
      }
      const issue = add({ title: body.title, description: body.description, parentId: body.parentId, priority: body.priority, projectId: body.projectId });
      if (body.idempotencyKey) state.idem.set(body.idempotencyKey, issue.id);
      return json(res, 201, withRelations(issue));
    }
    if ((match = path.match(/^\/api\/issues\/([^/]+)$/)) && m === "GET") {
      const key = decodeURIComponent(match[1]);
      const issue = state.issues.get(key) ?? [...state.issues.values()].find((i) => i.identifier === key);
      if (!issue) return json(res, 404, { error: "Issue not found" });
      const ancestors = [];
      let p = issue.parentId && state.issues.get(issue.parentId);
      while (p) {
        ancestors.push(summary(p));
        p = p.parentId && state.issues.get(p.parentId);
      }
      return json(res, 200, { ...withRelations(issue), ancestors });
    }
    if ((match = path.match(/^\/api\/issues\/([^/]+)\/comments$/)) && m === "POST") {
      const body = await readBody(req);
      const existing = state.comments.find((c) => c.clientRequestId && c.clientRequestId === body.clientRequestId);
      if (existing) return json(res, 201, existing);
      const c = { id: randomUUID(), issueId: match[1], clientRequestId: body.clientRequestId, authorType: "user", body: body.body, createdAt: new Date().toISOString() };
      state.comments.push(c);
      return json(res, 201, c);
    }
    return notFound(res);
  }
  return { handle, reset: seed, state };
}
