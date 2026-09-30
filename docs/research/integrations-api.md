# Upstream integration APIs: research notes

Researched 2026-09-30 for the dashboard's server-side adapters. These notes cover auth, endpoints, request and response shapes, and deep links for Paperclip, Skylight, Todoist, Home Assistant and Web Push (VAPID).

## Evidence legend

Every claim carries one of these tags:

| Tag | Meaning |
|-----|---------|
| **[V-src]** | Verified in upstream source code or official docs at the commit or date given. |
| **[V-live]** | Verified with a live, unauthenticated HTTP request on 2026-09-30. |
| **[Community]** | Taken from unofficial community clients or reverse-engineered specs. Not first-party. |
| **[Inferred]** | My reading or recommendation. Not confirmed by a source. Treat as an assumption. |

The fixtures are **shape-accurate but synthetic**. IDs, names and emails are made up. Fields that don't matter for the adapters are trimmed, and those spots are marked with a `"…"` comment in the prose, never inside the JSON.

---

## 1. Paperclip (paperclipai/paperclip)

Source checked: `github.com/paperclipai/paperclip` @ `f38b5693` (2026-09-29). I read `docs/api/*.md`, `server/src/{app.ts,middleware/auth.ts,middleware/board-mutation-guard.ts,routes/{issues,companies,projects,access}.ts,services/{issues,board-auth}.ts}`, `packages/shared/src/{constants.ts,types/{issue,company,project,search}.ts,validators/{issue,access,search}.ts,project-url-key.ts}`, `ui/src/{App.tsx,lib/utils.ts}` and `doc/CLI.md`.

### 1.1 Base URL and auth

- **Base path** is `{PAPERCLIP_URL}/api`, for example `http://localhost:3100/api`. All routes are mounted with `app.use("/api", api)`, and unknown `/api/*` routes return 404 `{"error":"API route not found"}`. **[V-src]**
- **Header** is `Authorization: Bearer <token>`, matched case-insensitively against `^bearer`. **[V-src]**
- **Token types** are resolved in this order in `middleware/auth.ts` **[V-src]**:
  1. **Board API key**. The format is `pcp_board_<48 hex chars>` (`createBoardApiToken()` = `pcp_board_` + 24 random bytes as hex). It's stored hashed and acts as the owning **user**, with `actor.type="board"` and `source="board_key"`. **This is the right credential for the dashboard.**
  2. **Agent API key**. This is a long-lived key scoped to one agent and company.
  3. **Agent run JWT**. This is short-lived and injected as `PAPERCLIP_API_KEY` during heartbeats.
  4. If there's no bearer, a Better Auth session cookie is used in `authenticated` mode, or an implicit board in `local_trusted` mode.
- **Creating a board key** **[V-src]**:
  - CLI: `npx paperclipai token board create --name dashboard [--company-id <id>] [--ttl-days N]`
  - API (needs an existing board session): `POST /api/board-api-keys` with body `{ "name": "dashboard", "expiresAt": null | ISO, "requestedCompanyId": uuid? }`. The response is **201** `{ id, name, token, createdAt, lastUsedAt, revokedAt, expiresAt }`. The plaintext `token` is shown only once.
  - The default TTL is **30 days** (`BOARD_API_KEY_TTL_MS`). The server maps `expiresAt: null` to "no expiry". The CLI flags are `--ttl-days`.
  - To revoke: `DELETE /api/board-api-keys/:keyId`. To list: `GET /api/board-api-keys`.
  - To check identity: `GET /api/cli-auth/me` returns `{ user, userId, isInstanceAdmin, companyIds, memberships, source:"board_key", keyId }`.
- **CSRF guard**: board mutations from browser sessions need a trusted Origin or Referer. Requests with `source === "board_key"` are **exempt**, so server-to-server POST and PATCH calls are fine. **[V-src]**
- **Optional header**: `X-Paperclip-Run-Id` is for agent runs only. The dashboard should not send it. **[V-src]**
- **Errors** are JSON `{ "error": "..." }`. Codes: 400 validation, 401 auth, 403 authz, 404, 409 conflict, 422 semantic, 429 with `Retry-After` on list coalescing overload. **[V-src]**
- **Health check**: `GET /api/health` (router mounted at `/health`). **[V-src]** The response shape wasn't examined, so treat it as liveness only. **[Inferred]**

### 1.2 Enumerations **[V-src]** (`packages/shared/src/constants.ts`)

```text
IssueStatus    = backlog | todo | in_progress | in_review | done | blocked | cancelled
IssuePriority  = critical | high | medium | low
IssueWorkMode  = standard | ask | planning | skill_test
ProjectStatus  = backlog | planned | in_progress | completed | cancelled
CompanyStatus  = active | paused | archived
CommentAuthor  = user | agent | system
```

The terminal statuses are `done` and `cancelled`. The lifecycle is `backlog → todo → in_progress → in_review → done`, with `blocked` as a side state. `in_progress` requires checkout, which is an agent concept. **[V-src docs]**

### 1.3 Endpoints the dashboard needs

| Purpose | Method and path | Notes |
|---|---|---|
| List companies | `GET /api/companies?scope=accessible` | Returns a bare array of `Company`. `scope` must be exactly `accessible` or omitted, otherwise 400. **[V-src]** |
| Get company | `GET /api/companies/{companyId}` | **[V-src docs]** |
| List issues | `GET /api/companies/{companyId}/issues` | Returns a bare array of `Issue`, or `CompactIssue` with `view=compact`. See the query params below. **[V-src]** |
| Count issues | `GET /api/companies/{companyId}/issues/count` | Same filters. **[V-src]** (response shape not examined) |
| Full-text search | `GET /api/companies/{companyId}/search?q=&scope=&status=&priority=&limit=&offset=` | Returns `CompanySearchResponse`. **[V-src]** |
| Get issue | `GET /api/issues/{idOrIdentifier}` | Accepts a **UUID or identifier** such as `PAP-224`. `svc.getById` normalizes identifiers. Adds `project`, `goal`, `ancestors`, `blockedBy`, `blocks`, `planDocument` and `documentSummaries`. **[V-src]** |
| List comments | `GET /api/issues/{id}/comments?order=asc\|desc&after=<commentId>&limit=` | Default order is `desc`. **[V-src]** |
| Add comment | `POST /api/issues/{id}/comments` | Returns **201** with an `IssueComment`. **[V-src]** |
| Create issue | `POST /api/companies/{companyId}/issues` | Returns **201** with the new issue, or **200** with `deduplicated:true` on replay. **[V-src]** |
| Update issue | `PATCH /api/issues/{id}` | Returns the row plus `changes` and `comment`. `Prefer: return=minimal` returns a compact receipt. **[V-src docs]** |
| List projects | `GET /api/companies/{companyId}/projects[?includeArchived=true]` | Returns a bare array of `Project`. List results include `taskCount` and `budget`. **[V-src]** |
| Get project | `GET /api/projects/{projectId}` | **[V-src docs]** |

**List-issues query params** **[V-src]** (`routes/issues.ts` ~L7774):

- `status` is comma-separated, for example `todo,in_progress,blocked`.
- `q` is a text search.
- `projectId`, `parentId` (alias `parentIssueId`), `descendantOf`, `labelId`.
- `assigneeAgentId` takes a UUID or the literal `null`. `assigneeUserId` takes an id or `me`, and `me` needs a board actor.
- `touchedByUserId`, `unreadForUserId` and `inboxArchivedByUserId` also accept `me`.
- `attention=blocked`.
- `includeBlockedBy=true` adds a `blockedBy[]` summary to each row.
- `view=compact`.
- `limit` defaults to **500** and maxes at **1000**. `offset` is a non-negative integer.
- `sortField` is `updated` or `id`. `sortDir` is `asc` or `desc`. `afterId` is a keyset cursor.
- `updatedSince` takes an ISO 8601 timestamp. Use it for incremental polling.
- Without `sortField`, results are ordered by priority. **[V-src docs]**

### 1.4 Issue shape (subset relevant to the dashboard) **[V-src]** (`types/issue.ts` `interface Issue`)

| Field | Type | Notes |
|---|---|---|
| `id` | uuid string | |
| `companyId` | uuid | |
| `identifier` | `string \| null` | Human key, for example `PAP-224`. It's `{company.issuePrefix}-{issueNumber}`. **[Inferred from `issuePrefix` and `issueNumber` fields]** |
| `issueNumber` | `number \| null` | |
| `title` | string | |
| `description` | `string \| null` | May be truncated, in which case `descriptionTruncated: true` is set. |
| `status` | IssueStatus | |
| `priority` | IssuePriority | |
| `assigneeAgentId` / `assigneeUserId` | `string \| null` | The assignee is either an agent or a user. There's no embedded assignee object, so resolve names via agents or users separately. **[Inferred]** |
| `parentId` | `uuid \| null` | |
| `ancestors` | `IssueAncestor[]` | Only present on `GET /issues/:id`. |
| `projectId`, `goalId` | `uuid \| null` | |
| `blockedBy` / `blocks` | `IssueRelationIssueSummary[]` | Dependency edges. On list endpoints you only get them with `includeBlockedBy=true`. |
| `labels` / `labelIds` | | |
| `startedAt`, `completedAt`, `cancelledAt`, `createdAt`, `updatedAt` | ISO strings over JSON | |
| `workMode`, `originKind`, `executionRunId`, `activeRun`, … | | Many more optional fields exist. Parse leniently (passthrough). |

`IssueRelationIssueSummary` = `{ id, identifier, title, status, priority, assigneeAgentId, assigneeUserId, terminalBlockers?, activeRecoveryAction?, scheduledRetry? }`. **[V-src]**

### 1.5 Create issue: parent and idempotency **[V-src]** (`validators/issue.ts` `createIssueSchema`)

Body fields (all optional unless marked):

- `title` (**required**, min 1)
- `description`
- `status`. If omitted, it defaults to **`todo` when an assignee is given, else `backlog`**.
- `priority`, default `medium`
- `parentId` (uuid). Must be a UUID, not an identifier. **[V-src: `z.string().guid()`]**
- `projectId`, `goalId`
- `assigneeAgentId` (uuid) and `assigneeUserId`
- `blockedByIssueIds: uuid[]`
- `labelIds: uuid[]`
- `billingCode`
- `idempotencyKey` (string, 1–255, trimmed). The server takes an advisory lock and looks up `(companyId, idempotencyKey)`. On a hit it returns the **original issue with HTTP 200** plus `deduplicated: true, deduplicationReason: "idempotency_key"`. Keys are kept for **7 days** (`ISSUE_CREATE_IDEMPOTENCY_KEY_RETENTION_DAYS`).
- `allowDuplicate` (default `false`). When `false`, the server also dedupes on **recent open issues with the same normalized title under the same parent**, with `deduplicationReason: "recent_open_title"`. Send `allowDuplicate: true` if repeated titles are legitimate.

Comment idempotency: `POST /issues/:id/comments` accepts `clientRequestId` (uuid). For **user** actors, which includes board keys, a repeat with the same `(issueId, authorUserId, clientRequestId)` returns the existing comment. The same id with a different body returns 409. **[V-src]** Other comment fields: `body` (required, markdown), `attachmentIds` (≤20 uuids), and `reopen`, `resume`, `interrupt` (booleans).

### 1.6 UI deep links **[V-src]** (`ui/src/App.tsx`, `ui/src/lib/utils.ts`)

The UI is company-prefixed under `/:companyPrefix`, where `companyPrefix` is `Company.issuePrefix` and matching is case-insensitive.

- **Issue:** `{PAPERCLIP_URL}/{issuePrefix}/issues/{identifier ?? id}`, for example `http://localhost:3100/PAP/issues/PAP-224`. `issueUrl()` builds `/issues/${identifier ?? id}`, and the router nests it under the prefix.
- The unprefixed `/issues/:issueId` also exists and redirects through `UnprefixedBoardRedirect`. It relies on the currently selected company, so prefer the prefixed form. **[Inferred]**
- **Project:** `{PAPERCLIP_URL}/{issuePrefix}/projects/{project.urlKey}`. Sub-tabs are `/overview`, `/issues` and `/configuration`. If `urlKey` is missing, it's derived by `deriveProjectUrlKey(name, id)`: lowercase, non-alphanumerics become `-`, and non-ASCII names get the first 8 hex chars of the UUID appended.

### 1.7 Fixtures

`GET /api/companies?scope=accessible` → 200
```json
[
  {
    "id": "5b0c8a2e-6a0f-4b8e-9d3c-1f2a3b4c5d6e",
    "name": "Paperclip Labs",
    "description": "Autonomous product team",
    "status": "active",
    "pauseReason": null,
    "pausedAt": null,
    "issuePrefix": "PAP",
    "issueCounter": 231,
    "budgetMonthlyCents": 100000,
    "spentMonthlyCents": 4210,
    "defaultResponsibleUserId": null,
    "requireBoardApprovalForNewAgents": true,
    "logoAssetId": null,
    "logoUrl": null,
    "createdAt": "2026-06-01T12:00:00.000Z",
    "updatedAt": "2026-09-29T08:00:00.000Z"
  }
]
```

`GET /api/companies/{companyId}/issues?status=todo,in_progress,blocked&includeBlockedBy=true&limit=50` → 200
```json
[
  {
    "id": "0e7f4d0a-2c1b-4a8e-bf1e-7c3d2a1b0f9e",
    "companyId": "5b0c8a2e-6a0f-4b8e-9d3c-1f2a3b4c5d6e",
    "projectId": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    "projectWorkspaceId": null,
    "goalId": null,
    "parentId": "9d8c7b6a-5f4e-4d3c-2b1a-0f9e8d7c6b5a",
    "title": "Wire Todoist adapter",
    "description": "Implement list + close + snooze.",
    "status": "blocked",
    "workMode": "standard",
    "priority": "high",
    "reviewPolicy": null,
    "assigneeAgentId": "3c2b1a0f-9e8d-4c7b-a6f5-e4d3c2b1a0f9",
    "assigneeUserId": null,
    "checkoutRunId": null,
    "executionRunId": null,
    "executionAgentNameKey": null,
    "executionLockedAt": null,
    "createdByAgentId": null,
    "createdByUserId": "user_01HX",
    "responsibleUserId": "user_01HX",
    "issueNumber": 224,
    "identifier": "PAP-224",
    "requestDepth": 0,
    "billingCode": null,
    "assigneeAdapterOverrides": null,
    "executionWorkspaceId": null,
    "executionWorkspacePreference": null,
    "executionWorkspaceSettings": null,
    "startedAt": null,
    "completedAt": null,
    "cancelledAt": null,
    "hiddenAt": null,
    "labelIds": [],
    "labels": [],
    "blockedBy": [
      {
        "id": "7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d",
        "identifier": "PAP-219",
        "title": "Decide token storage",
        "status": "in_review",
        "priority": "medium",
        "assigneeAgentId": null,
        "assigneeUserId": "user_01HX"
      }
    ],
    "createdAt": "2026-09-28T10:00:00.000Z",
    "updatedAt": "2026-09-29T16:20:00.000Z"
  }
]
```

`GET /api/issues/PAP-224` → 200 (trimmed: detail adds `ancestors`, `project`, `goal`, `blocks`, `documentSummaries`, `planDocument`)
```json
{
  "id": "0e7f4d0a-2c1b-4a8e-bf1e-7c3d2a1b0f9e",
  "companyId": "5b0c8a2e-6a0f-4b8e-9d3c-1f2a3b4c5d6e",
  "identifier": "PAP-224",
  "issueNumber": 224,
  "title": "Wire Todoist adapter",
  "description": "Implement list + close + snooze.",
  "status": "blocked",
  "priority": "high",
  "assigneeAgentId": "3c2b1a0f-9e8d-4c7b-a6f5-e4d3c2b1a0f9",
  "assigneeUserId": null,
  "parentId": "9d8c7b6a-5f4e-4d3c-2b1a-0f9e8d7c6b5a",
  "projectId": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  "goalId": null,
  "ancestors": [
    {
      "id": "9d8c7b6a-5f4e-4d3c-2b1a-0f9e8d7c6b5a",
      "identifier": "PAP-200",
      "title": "Personal dashboard v1",
      "description": null,
      "status": "in_progress",
      "priority": "high",
      "assigneeAgentId": null,
      "assigneeUserId": "user_01HX",
      "projectId": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
      "goalId": null,
      "project": null,
      "goal": null
    }
  ],
  "blockedBy": [
    { "id": "7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d", "identifier": "PAP-219", "title": "Decide token storage", "status": "in_review", "priority": "medium", "assigneeAgentId": null, "assigneeUserId": "user_01HX" }
  ],
  "blocks": [],
  "documentSummaries": [],
  "planDocument": null,
  "startedAt": null,
  "completedAt": null,
  "cancelledAt": null,
  "createdAt": "2026-09-28T10:00:00.000Z",
  "updatedAt": "2026-09-29T16:20:00.000Z"
}
```

`POST /api/companies/{companyId}/issues`, request:
```json
{
  "title": "Follow up: snooze semantics for recurring tasks",
  "description": "Created from dashboard.",
  "priority": "medium",
  "parentId": "0e7f4d0a-2c1b-4a8e-bf1e-7c3d2a1b0f9e",
  "projectId": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  "idempotencyKey": "dashboard:create:2f1c9a7e-3b1d-4d8e-9a0b-1c2d3e4f5a6b"
}
```
→ 201 (first call). A replay with the same key returns 200 with the same `id` plus `"deduplicated": true, "deduplicationReason": "idempotency_key"`.
```json
{
  "id": "c4d5e6f7-a8b9-4c0d-8e1f-2a3b4c5d6e7f",
  "companyId": "5b0c8a2e-6a0f-4b8e-9d3c-1f2a3b4c5d6e",
  "identifier": "PAP-232",
  "issueNumber": 232,
  "title": "Follow up: snooze semantics for recurring tasks",
  "description": "Created from dashboard.",
  "status": "backlog",
  "priority": "medium",
  "parentId": "0e7f4d0a-2c1b-4a8e-bf1e-7c3d2a1b0f9e",
  "projectId": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  "assigneeAgentId": null,
  "assigneeUserId": null,
  "relatedWork": { "outbound": [], "inbound": [] },
  "referencedIssueIdentifiers": [],
  "createdAt": "2026-09-30T05:00:00.000Z",
  "updatedAt": "2026-09-30T05:00:00.000Z"
}
```
The internal shape of `relatedWork` wasn't examined, so treat it as opaque. **[Inferred]**

`POST /api/issues/{id}/comments`, request:
```json
{ "body": "Snoozed from dashboard until Friday.", "clientRequestId": "6f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f" }
```
→ 201
```json
{
  "id": "e1d2c3b4-a5f6-4e7d-8c9b-0a1f2e3d4c5b",
  "companyId": "5b0c8a2e-6a0f-4b8e-9d3c-1f2a3b4c5d6e",
  "issueId": "0e7f4d0a-2c1b-4a8e-bf1e-7c3d2a1b0f9e",
  "clientRequestId": "6f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f",
  "authorType": "user",
  "authorAgentId": null,
  "authorUserId": "user_01HX",
  "body": "Snoozed from dashboard until Friday.",
  "presentation": null,
  "metadata": null,
  "createdAt": "2026-09-30T05:01:00.000Z",
  "updatedAt": "2026-09-30T05:01:00.000Z"
}
```

`GET /api/companies/{companyId}/projects` → 200
```json
[
  {
    "id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    "companyId": "5b0c8a2e-6a0f-4b8e-9d3c-1f2a3b4c5d6e",
    "urlKey": "personal-dashboard",
    "goalId": null,
    "goalIds": [],
    "goals": [],
    "name": "Personal Dashboard",
    "description": null,
    "status": "in_progress",
    "leadAgentId": null,
    "targetDate": null,
    "color": "#6366f1",
    "icon": null,
    "env": null,
    "pauseReason": null,
    "pausedAt": null,
    "executionWorkspacePolicy": null,
    "codebase": null,
    "workspaces": [],
    "primaryWorkspace": null,
    "taskCount": 42,
    "budget": null,
    "archivedAt": null,
    "createdAt": "2026-07-01T00:00:00.000Z",
    "updatedAt": "2026-09-29T00:00:00.000Z"
  }
]
```
`codebase` is typed `ProjectCodebase` and its shape wasn't examined. The `null` above is a placeholder. **[Inferred]**

Error fixture (401). An unknown, expired or revoked board key falls through to the agent-token path, so it gets this message:
```json
{ "error": "Agent token did not verify; obtain fresh credentials and retry" }
```
The text varies ("Expired agent token; …" for expired JWTs, "Empty bearer token; …"), so match on status, not text. **[V-src `invalidAgentTokenMessage()`]**

---

## 2. Skylight Calendar (ourskylight.com): unofficial API

**There is no official API.** Everything here is reverse-engineered. Sources:

- `joshuaswarren/pyskylight` (Python, 2026-06)
- `sebrandon1/go-skylight` (Go, 2026-09-29)
- `jwmoss/skycli` (Go, 2026-09-29)
- `TheEagleByte/skylight-mcp` (TS, 2025-12)
- The OpenAPI spec generated from HAR captures at `theeaglebyte.github.io/skylight-api/openapi/openapi.yaml` (generated 2025-12-29)

All of these are **[Community]** unless marked **[V-live]**.

### 2.1 Base URL and headers

- **Host:** `https://app.ourskylight.com`. Data endpoints live under `/api`. **[V-live: `GET /api/frames` → 401 `{"errors":["Invalid token"]}`]**
- **Format:** JSON:API style, with `{ data, included?, meta? }` and resources `{ id, type, attributes, relationships }`. IDs are **strings**. **[Community + V-live error shape]**
- **Auth header (current):** `Authorization: Bearer <access_token>`. Both Go clients (go-skylight, skycli) use this. **[Community]**
- **Legacy auth header:** `Authorization: Basic base64("<userId>:<token>")`, built from the old `/api/sessions` token. skylight-mcp still builds it. It's only useful for tokens obtained before sessions were retired. **[Community]**
- **Version header:** `skylight-api-version: <YYYY-MM-DD>`. The live server echoes `skylight-api-version: 2026-01-01` **[V-live]**. go-skylight sends `2026-06-01` and skycli sends `2026-04-15` **[Community]**. Pin one value and make it configurable.
- **Rate limits:** unknown.

### 2.2 Login: `POST /api/sessions` is RETIRED

`POST /api/sessions` with `{}` returns **401** `{"errors":["This version of Skylight is no longer supported. Please update to the latest version in the App Store or Google Play to continue."]}`. **[V-live]** pyskylight and go-skylight also document it as deprecated.

For reference only, the historical shape was:
- request `{ "email", "password" }`
- response `{ data: { id: "<userId>", type: "authenticated_user", attributes: { email, token, subscription_status } }, meta: { password_reset } }` **[Community]**

**Current login is OAuth2 authorization-code (+PKCE) against the web login form** **[Community, cross-checked in 3 clients]**:

1. `GET /auth/session/new` loads the HTML login form. Extract `authenticity_token` with the regex `name="authenticity_token"[^>]*value="([^"]+)"`. Keep a **cookie jar** and send a browser `User-Agent`. **[V-live: 200]**
2. `POST /auth/session`. The body is `application/x-www-form-urlencoded` with `authenticity_token`, `email` and `password`, plus `Origin` and `Referer` headers. The server answers 302 on both success and failure. **A redirect back to `/auth/session/new` means the login was rejected**, either from bad credentials or a pending 2FA or device verification.
3. `GET /oauth/authorize` with these parameters:
   - `client_id=skylight-mobile`
   - `response_type=code`
   - `redirect_uri=https://ourskylight.com/welcome`
   - `scope=everything`
   - `skylight_api_client_device_fingerprint=<stable UUID>`
   - optionally `code_challenge=<S256>` and `code_challenge_method=S256`

   Don't follow redirects. Read `code` from the `Location` header. **[V-live: unauthenticated authorize → 302 to `/auth/session/new`]**
4. `POST /oauth/token` (form-encoded) with `grant_type=authorization_code`, `code`, `client_id=skylight-mobile`, `redirect_uri` (same as above), `scope=everything`, `skylight_api_client_device_fingerprint`, and `code_verifier` (if you used PKCE). The response is `{ access_token, refresh_token, token_type, expires_in, created_at? }`.
5. To refresh: `POST /oauth/token` with `grant_type=refresh_token`, `refresh_token`, `client_id=skylight-mobile` and `skylight_api_client_device_fingerprint`. **The refresh token rotates on every use, so persist the new one atomically.**

The clients disagree on the redirect URI. pyskylight uses `skylight-family://welcome` with `prompt=login`, while go-skylight and skycli use `https://ourskylight.com/welcome` plus a device fingerprint. **[Community]** Prefer the go-skylight variant, which is the newest and most tested.

**[Inferred] Recommendation:** don't automate email and password login in the dashboard. Do a one-time bootstrap with `skycli auth login` or `go-skylight`, then store the **refresh token + fingerprint** as secrets and refresh server-side. Treat any 401 as "re-auth required" and surface it in the UI. 2FA or device verification can block headless login.

### 2.3 Endpoints

All paths below are relative to `https://app.ourskylight.com/api`.

| Purpose | Method and path | Params / body |
|---|---|---|
| List frames (households) | `GET /frames` | Returns `data: [{ id, type: "frame_show" …, attributes: { name, household_name?, timezone, hardware_model?, mine?, plus?, activated? } }]`. The `type` string is only seen in go-skylight test fixtures, so don't assert on it. |
| Get frame | `GET /frames/{frameId}` | |
| Categories (family members / colors) | `GET /frames/{frameId}/categories` | Used to resolve `relationships.category(ies)` on events and chores. |
| Calendar events | `GET /frames/{frameId}/calendar_events?date_min=YYYY-MM-DD&date_max=YYYY-MM-DD&timezone=<IANA>&include=categories,calendar_account,event_notification_setting` | Recurring instances come back **expanded**, with ids like `"<eventId>-<unixStart>"`. |
| Source calendars | `GET /frames/{frameId}/source_calendars` | |
| Chores | `GET /frames/{frameId}/chores?after=YYYY-MM-DD&before=YYYY-MM-DD[&include_late=true][&filter=linked_to_profile][&assignee_id=]` | **`after` and `before` are required.** Without them you get 422 "after can't be blank". Recurring instance ids look like `"<baseId>-YYYY-MM-DD[-HHMM]"`. |
| Complete / skip chore | `PUT /frames/{frameId}/chores/{baseId}/completions` | Body `{ "status": "complete" \| "pending" \| "skipped", "instance_date": "YYYY-MM-DD", "instance_time": "HH:MM"?, "defer_until"? }`. `baseId`, `instance_date` and `instance_time` come from parsing the composite id. |
| Lists | `GET /frames/{frameId}/lists` | `included[]` holds `list_item` resources. `kind` is `shopping` or `to_do`. |
| Get list | `GET /frames/{frameId}/lists/{listId}` | |
| Add list item | `POST /frames/{frameId}/lists/{listId}/list_items` | Flat body `{ "label": "Milk", "position"?: n, "status"?: "completed" }`. |
| Update / check off list item | `PUT /frames/{frameId}/lists/{listId}/list_items/{itemId}` | Flat body `{ "status": "completed" \| "pending", "label"? }`. |
| Delete list item | `DELETE /frames/{frameId}/lists/{listId}/list_items/{itemId}` | |

**Deep links:** there are no known public web deep links for individual events, chores or lists. Link to `https://app.ourskylight.com/` (the web app) at most. **[Inferred]**

### 2.4 Fixtures (anonymized; shapes from the HAR-derived spec and client tests)

`POST /oauth/token` → 200 (field names from the client structs; the values, including `expires_in`, are illustrative) **[Community]**
```json
{
  "access_token": "sk_at_REDACTED",
  "token_type": "Bearer",
  "expires_in": 7200,
  "refresh_token": "sk_rt_REDACTED",
  "created_at": 1790744228
}
```

`GET /api/frames` → 200
```json
{
  "data": [
    {
      "id": "4418006",
      "type": "frame_show",
      "attributes": {
        "name": "Kitchen Calendar",
        "household_name": "The Example Family",
        "timezone": "America/New_York",
        "hardware_model": "calendar_15",
        "mine": true,
        "plus": true,
        "activated": true
      }
    }
  ]
}
```

`GET /api/frames/4418006/calendar_events?date_min=2026-09-28&date_max=2026-10-04&timezone=America/New_York&include=categories` → 200
```json
{
  "data": [
    {
      "id": "5355662012-1790778600",
      "type": "calendar_event",
      "attributes": {
        "summary": "Team 1:1",
        "description": null,
        "location": null,
        "starts_at": "2026-09-30T09:30:00.000-04:00",
        "ends_at": "2026-09-30T10:00:00.000-04:00",
        "all_day": false,
        "timezone": "America/New_York",
        "recurring": true,
        "rrule": ["RRULE:FREQ=WEEKLY;WKST=MO"],
        "kind": "standard",
        "source": "google",
        "status": "approved",
        "editable": true,
        "calendar_id": "parent@example.com",
        "owner_email": "parent@example.com",
        "uid": "abc123def456",
        "master_event_id": null,
        "countdown_enabled": false,
        "invited_emails": [],
        "lat": null,
        "lng": null
      },
      "relationships": {
        "categories": { "data": [{ "id": "13600771", "type": "category" }] },
        "calendar_account": { "data": { "id": "1570313", "type": "calendar_account" } },
        "event_notification_setting": { "data": null }
      }
    },
    {
      "id": "5355700001",
      "type": "calendar_event",
      "attributes": {
        "summary": "School holiday",
        "description": null,
        "location": null,
        "starts_at": "2026-10-02T00:00:00.000-04:00",
        "ends_at": "2026-10-03T00:00:00.000-04:00",
        "all_day": true,
        "timezone": "America/New_York",
        "recurring": false,
        "rrule": null,
        "kind": "standard",
        "source": "skylight",
        "status": "approved",
        "editable": true
      },
      "relationships": {
        "categories": { "data": [{ "id": "14463836", "type": "category" }] }
      }
    }
  ],
  "included": [
    {
      "id": "13600771",
      "type": "category",
      "attributes": { "id": 13600771, "label": "Alex", "color": "#CB434C", "linked_to_profile": true, "profile_pic_url": null, "selected_for_chore_chart": true }
    },
    {
      "id": "14463836",
      "type": "category",
      "attributes": { "id": 14463836, "label": "Family", "color": "#4986e7", "linked_to_profile": false, "profile_pic_url": null, "selected_for_chore_chart": false }
    }
  ]
}
```
The all-day `starts_at`/`ends_at` representation and the `"skylight"` source value are **[Inferred]**. The HAR sample only shows timed Google events. Parse `all_day` first.

`GET /api/frames/4418006/chores?after=2026-09-30&before=2026-09-30&include_late=true` → 200
```json
{
  "data": [
    {
      "id": "55900629",
      "type": "chore",
      "attributes": {
        "id": 55900629,
        "summary": "Schedule vet appointment",
        "emoji_icon": "🐾",
        "status": "pending",
        "start": "2026-09-30",
        "start_time": null,
        "recurring": false,
        "recurrence_set": null,
        "recurring_until": null,
        "routine": false,
        "reward_points": null,
        "position": 1,
        "group": "55900629",
        "completed_on": null
      },
      "relationships": { "category": { "data": { "id": "13624117", "type": "category" } } }
    },
    {
      "id": "55780859-2026-09-30-0600",
      "type": "chore",
      "attributes": {
        "id": "55780859-2026-09-30-0600",
        "summary": "Feed animals",
        "emoji_icon": "🐾",
        "status": "complete",
        "start": "2026-09-30",
        "start_time": "06:00",
        "recurring": true,
        "recurrence_set": ["RRULE:FREQ=DAILY;INTERVAL=1;BYHOUR=6"],
        "recurring_until": null,
        "routine": true,
        "reward_points": null,
        "position": 1,
        "group": "55780859",
        "completed_on": "2026-09-30"
      },
      "relationships": { "category": { "data": { "id": "13600771", "type": "category" } } }
    }
  ]
}
```
In the HAR sample, `attributes.id` is a number for one-off chores and a composite string for recurring instances. Type it as `number | string`.

`PUT /api/frames/4418006/chores/55780859/completions`, request:
```json
{ "status": "complete", "instance_date": "2026-09-30", "instance_time": "06:00" }
```

`GET /api/frames/4418006/lists` → 200
```json
{
  "data": [
    {
      "id": "4493487",
      "type": "list",
      "attributes": { "label": "Grocery List", "kind": "shopping", "color": "#B6E085", "default_grocery_list": true, "hide_on_device": false },
      "relationships": { "list_items": { "data": [{ "id": "104851329", "type": "list_item" }, { "id": "104862172", "type": "list_item" }] } }
    },
    {
      "id": "4493488",
      "type": "list",
      "attributes": { "label": "To-Do List", "kind": "to_do", "color": "#A8D4D3", "default_grocery_list": false, "hide_on_device": false },
      "relationships": { "list_items": { "data": [] } }
    }
  ],
  "included": [
    {
      "id": "104851329",
      "type": "list_item",
      "attributes": { "id": 104851329, "label": "Eggs", "status": "pending", "section": null, "position": 1, "created_at": "2026-09-29T18:33:24.183Z" },
      "relationships": { "list": { "data": { "id": "4493487", "type": "list" } } }
    },
    {
      "id": "104862172",
      "type": "list_item",
      "attributes": { "id": 104862172, "label": "Bagels", "status": "completed", "section": "Bakery", "position": 1, "created_at": "2026-09-29T18:48:33.105Z" },
      "relationships": { "list": { "data": { "id": "4493487", "type": "list" } } }
    }
  ]
}
```

Error fixtures **[V-live]**:
```json
{ "errors": ["Invalid token"] }
```
```json
{ "errors": ["This version of Skylight is no longer supported. Please update to the latest version in the App Store or Google Play to continue."] }
```

---

## 3. Todoist: unified API v1

Source: the official docs at `developer.todoist.com/api/v1/`. I extracted the embedded OpenAPI (Redoc) on 2026-09-30.

### 3.1 Status of REST v2

**REST v2 is shut down, not just deprecated.** `GET https://api.todoist.com/rest/v2/tasks` returns **HTTP 410** with the plain-text body "This endpoint is deprecated. … please update your use case to rely on the new API endpoints, available under /api/v1/ prefixes." **[V-live]** The docs' "Migrating from v9" section says v1 unifies Sync v9 and REST v2. **[V-src docs]**

### 3.2 Auth and base URL **[V-src docs]**

- The base is `https://api.todoist.com/api/v1`. Paths must be lowercase, and mixed case returns 404.
- The header is `Authorization: Bearer <token>`, using a personal API token from Settings → Integrations → Developer, or an OAuth token.
- Errors are JSON. **[V-live]**
  ```json
  {"error":"Unauthorized","error_code":477,"error_extra":{"event_id":"…","retry_after":1},"error_tag":"UNAUTHORIZED","http_code":401}
  ```
- IDs are opaque strings such as `"6XGgmFVcrG5RRjVr"`. Old numeric v9 IDs are **rejected**. `GET /api/v1/ids_mapping/<object>/<ids>` converts them.
- Limits: a 1 MiB POST body, a 15 s processing timeout, and sync limits of 1000 partial and 100 full syncs per 15 min per user. The docs don't state a separate REST-endpoint limit. **[V-src docs]**

### 3.3 Endpoints

| Purpose | Method and path | Notes |
|---|---|---|
| Active tasks (structured filters) | `GET /api/v1/tasks?project_id=&section_id=&parent_id=&label=&ids=a,b&limit=&cursor=` | **No `filter` param in v1.** It was moved to the next endpoint. **[V-src]** |
| Active tasks by filter query | `GET /api/v1/tasks/filter?query=<todoist filter>&lang=&limit=&cursor=` | `query` is required, 1–1024 chars, for example `today \| overdue`. **[V-src]** |
| Get task | `GET /api/v1/tasks/{task_id}` | **[V-src]** |
| Close (complete) task | `POST /api/v1/tasks/{task_id}/close` | Recurring tasks advance to the next occurrence instead of completing. The spec says `200` with schema `{}`, so don't rely on the body. **[V-src]** |
| Reopen | `POST /api/v1/tasks/{task_id}/reopen` | **[V-src]** |
| Update (snooze) | `POST /api/v1/tasks/{task_id}` | Note it's **POST**, not PATCH. Returns 200 with the updated task. **[V-src]** |

**Pagination** **[V-src]**: responses look like `{ "results": [...], "next_cursor": string|null }`. `limit` defaults to 50 and maxes at 200. Pass the same params again with `cursor`.

**Update body fields for snoozing** **[V-src]** (all optional):

- `due_string` (natural language, for example `"tomorrow 9am"`)
- `due_date` (`YYYY-MM-DD`)
- `due_datetime` (RFC 3339, for example `"2026-10-01T13:00:00Z"`)
- `due_lang`
- also accepted: `content`, `description`, `labels`, `priority`, `assignee_id`, `duration` + `duration_unit` (`minute` or `day`), `deadline_date`, `child_order`, `day_order`, `is_collapsed`

Send only one of `due_string`, `due_date` or `due_datetime`. **[Inferred]**

**[Inferred] caveat:** setting an explicit `due_date` or `due_datetime` on a **recurring** task probably replaces the recurrence. To snooze one occurrence while keeping the recurrence, you'd need a `due_string` that re-states the recurrence, or the Sync API `item_update` with a full `due` object. Verify with a live test before shipping snooze for recurring tasks.

### 3.4 Task object (`ItemSyncView`) **[V-src]**

These fields are required in the schema:

`id`, `user_id`, `project_id`, `section_id|null`, `parent_id|null`, `added_by_uid`, `assigned_by_uid`, `responsible_uid`, `labels[]`, `deadline|null`, `duration|null`, `is_collapsed`, `checked`, `is_deleted`, `added_at`, `completed_at|null`, `completed_by_uid`, `updated_at`, `due|null`, `priority`, `child_order`, `order_key`, `content`, `description`, `note_count`, `day_order`, `completed_count`, `postponed_count`.

- **`priority`** is an integer from 1 to 4, where **4 = urgent** (shown as "P1" in the UI) and 1 = normal. The task schema and the URL-scheme docs agree on this. The update-body field description says "1 is highest", which contradicts both. **[V-src: docs inconsistent]** Map 4 to P1.
- **`due`** is `{ date, timezone, string, lang, is_recurring }`. **There is no separate `datetime` field in v1.** REST v2 had `due.datetime`. **[V-src]** The `date` field is one of:
  - **full-day:** `"2026-10-01"`, with `timezone: null`
  - **floating time:** `"2026-10-01T12:00:00.000000"` (no `Z`), with `timezone: null`
  - **fixed zone:** `"2026-10-01T05:00:00.000000Z"` (UTC), with `timezone: "Asia/Jakarta"`

  To derive date vs datetime, check `date.length === 10`.
- **There is no `url` field in v1.** The v2 `url` was removed. **[V-src]**

### 3.5 Deep links **[V-src docs]**

- Web: `https://app.todoist.com/app/task/{id}`, using the v1 string id.
- Native app: `todoist://task?id={id}`.
- Pre-filled add-task view: `todoist://addtask?content=…&date=…&priority=4`.

### 3.6 Fixtures

`GET /api/v1/tasks/filter?query=today%20%7C%20overdue&limit=50` → 200
```json
{
  "results": [
    {
      "id": "6XGgmFVcrG5RRjVr",
      "user_id": "1234567",
      "project_id": "6XGgm6PHrGgMpCFX",
      "section_id": null,
      "parent_id": null,
      "added_by_uid": "1234567",
      "assigned_by_uid": null,
      "responsible_uid": null,
      "labels": ["errands"],
      "deadline": null,
      "duration": null,
      "is_collapsed": false,
      "checked": false,
      "is_deleted": false,
      "added_at": "2026-09-28T10:30:00Z",
      "completed_at": null,
      "completed_by_uid": null,
      "updated_at": "2026-09-29T08:00:00Z",
      "due": { "date": "2026-09-30", "timezone": null, "string": "today", "lang": "en", "is_recurring": false },
      "priority": 4,
      "child_order": 1,
      "order_key": "a1V",
      "content": "Buy milk",
      "description": "",
      "note_count": 0,
      "day_order": 1,
      "completed_count": 0,
      "postponed_count": 0
    },
    {
      "id": "6fFPHV272WWh3gpW",
      "user_id": "1234567",
      "project_id": "6XGgm6PHrGgMpCFX",
      "section_id": null,
      "parent_id": null,
      "added_by_uid": "1234567",
      "assigned_by_uid": null,
      "responsible_uid": null,
      "labels": [],
      "deadline": { "date": "2026-10-03", "lang": "en" },
      "duration": { "amount": 30, "unit": "minute" },
      "is_collapsed": false,
      "checked": false,
      "is_deleted": false,
      "added_at": "2026-09-01T09:00:00Z",
      "completed_at": null,
      "completed_by_uid": null,
      "updated_at": "2026-09-29T08:00:00Z",
      "due": { "date": "2026-09-30T13:00:00.000000Z", "timezone": "America/New_York", "string": "every day at 9am", "lang": "en", "is_recurring": true },
      "priority": 1,
      "child_order": 2,
      "order_key": "a2",
      "content": "Stand-up notes",
      "description": "",
      "note_count": 0,
      "day_order": 2,
      "completed_count": 41,
      "postponed_count": 3
    }
  ],
  "next_cursor": null
}
```

`POST /api/v1/tasks/6XGgmFVcrG5RRjVr` (snooze), request:
```json
{ "due_date": "2026-10-02" }
```
or
```json
{ "due_string": "tomorrow at 9am", "due_lang": "en" }
```
→ 200, returning the full task object with an updated `due`.

`POST /api/v1/tasks/6XGgmFVcrG5RRjVr/close` → 200 (the body is not relied upon, so a fixture of `{}` or empty is fine)

Error fixture (404) **[V-src docs format]**:
```json
{ "error": "Task not found", "error_code": 478, "error_extra": { "event_id": "0a6c23c8d07144fd915bebd8a3e7d50d", "retry_after": 3 }, "error_tag": "NOT_FOUND", "http_code": 404 }
```

---

## 4. Home Assistant REST API

Sources: `home-assistant/developers.home-assistant` `docs/api/rest.md` (2026-09-29) and `home-assistant/core` (dev, version 2026.10) components `api`, `calendar`, `todo` and `persistent_notification`. **[V-src]**

### 4.1 Auth and base

- Base: `http(s)://<host>:8123/api/`. The API root is **`/api/` with a trailing slash**.
- Header: `Authorization: Bearer <long-lived access token>`. Create the token at `/profile` → Security.
- The API is JSON-only. It returns 200/201 on success, and 400, 401, 404 or 405 on errors.
- A non-admin user token works for reads. The calendar view checks per-entity `POLICY_READ`. **[V-src]**

### 4.2 Endpoints

| Purpose | Method and path | Response |
|---|---|---|
| Liveness | `GET /api/` | `{"message":"API running."}` |
| Config | `GET /api/config` | Includes `time_zone`, `version`, `location_name`, … |
| All states | `GET /api/states` | `State[]` |
| One state | `GET /api/states/{entity_id}` | `State`, or 404 |
| Call service | `POST /api/services/{domain}/{service}` | Body is service data plus `entity_id`. By default it returns `State[]` (the changed states). |
| Call with response | `POST /api/services/{domain}/{service}?return_response` | Returns `{ "changed_states": State[], "service_response": { "<entity_id>": {...} } }`. **You get 400 if you omit `return_response` on a response-only service**, such as `todo.get_items, or if you add it to a service with no response. [V-src: `api/__init__.py` L409–476] |
| List calendars | `GET /api/calendars` | `[{ "entity_id", "name" }]` |
| Calendar events | `GET /api/calendars/{entity_id}?start=<ISO>&end=<ISO>` | Both params are required, otherwise 400. It also returns 400 if `start > end` or the entity isn't a calendar. The range is **exclusive**. Events are `{ start, end, summary, description, location, uid, recurrence_id, rrule, status? }`. `start` and `end` are either `{ "dateTime": "<local ISO>" }` or `{ "date": "YYYY-MM-DD" }` for all-day events. **None-valued fields are included as `null`** (`api_event_dict_factory` doesn't drop them). **[V-src]** |

`State` = `{ entity_id, state, attributes, last_changed, last_reported?, last_updated, context: { id, parent_id, user_id } }`. The docs examples omit `context` and `last_reported`, but live HA includes them. **[Inferred from HA core State.as_dict]** Parse leniently.

### 4.3 To-do entities **[V-src]** (`components/todo`)

- The entity `state` is the **count of `needs_action` items**, as a string in REST, for example `"3"`. `supported_features` is a bitmask:
  - `1` CREATE
  - `2` DELETE
  - `4` UPDATE
  - `8` MOVE
  - `16` SET_DUE_DATE
  - `32` SET_DUE_DATETIME
  - `64` SET_DESCRIPTION
- `todo.get_items` is `SupportsResponse.ONLY`, so it **must** be called with `?return_response`. The body is `{ "entity_id": "todo.x", "status": ["needs_action"] }`. `status` is optional, with values `needs_action` or `completed`. The response for each entity is `{ "items": [ { uid, summary, status, due?, description?, completed? } ] }`. Null fields are **omitted**, values are stringified, and dates are ISO.
- `todo.update_item` takes `{ "entity_id", "item": "<uid or summary>", "rename"?, "status"?: "needs_action"|"completed", "due_date"? | "due_datetime"?, "description"? }`. Send at most one of `due_date` or `due_datetime`. Setting a field the entity doesn't support raises a validation error (400). **Match by `uid`**, because summary matching takes the first hit.
- Other services: `todo.add_item` `{ item, due_date?|due_datetime?, description? }`, `todo.remove_item` `{ item: [uid…] }` and `todo.remove_completed_items`.
- Deep link: `{HA_URL}/todo?entity_id=todo.shopping_list`. **[Inferred: HA frontend to-do panel URL. Not verified in frontend source.]**

### 4.4 Persistent notifications **[V-src]**

- To create: `POST /api/services/persistent_notification/create` with `{ "message": "...", "title"?: "...", "notification_id"?: "dashboard_x" }`. Reusing a `notification_id` updates the existing notification.
- To dismiss: `POST /api/services/persistent_notification/dismiss` with `{ "notification_id": "..." }`. `dismiss_all` takes no fields.
- **To read the list, REST alone isn't enough.** Notifications are no longer `persistent_notification.*` state entities. You have to use the **WebSocket** command `{"type":"persistent_notification/get"}`, which returns `[{ message, notification_id, title, created_at }]`, or `persistent_notification/subscribe`. If the dashboard needs to show HA notifications, plan a small WS client, or have HA mirror them into a template sensor. **[Inferred]**

### 4.5 Fixtures

`GET /api/` → 200
```json
{ "message": "API running." }
```

`GET /api/states/todo.shopping_list` → 200
```json
{
  "entity_id": "todo.shopping_list",
  "state": "2",
  "attributes": { "friendly_name": "Shopping List", "supported_features": 15 },
  "last_changed": "2026-09-30T04:00:00.000000+00:00",
  "last_reported": "2026-09-30T04:00:00.000000+00:00",
  "last_updated": "2026-09-30T04:00:00.000000+00:00",
  "context": { "id": "01J9ZZZZZZZZZZZZZZZZZZZZZZ", "parent_id": null, "user_id": null }
}
```

`POST /api/services/todo/get_items?return_response` with body `{"entity_id":"todo.shopping_list","status":["needs_action"]}` → 200
```json
{
  "changed_states": [],
  "service_response": {
    "todo.shopping_list": {
      "items": [
        { "summary": "Milk", "uid": "3f1c2d4e-0000-4000-8000-000000000001", "status": "needs_action" },
        { "summary": "Pay water bill", "uid": "3f1c2d4e-0000-4000-8000-000000000002", "status": "needs_action", "due": "2026-10-01", "description": "Autopay failed" }
      ]
    }
  }
}
```

`POST /api/services/todo/get_items` (without `return_response`) → 400. The exact body text isn't pinned, so assert only on the status. **[V-src behaviour]**

`POST /api/services/todo/update_item`, request:
```json
{ "entity_id": "todo.shopping_list", "item": "3f1c2d4e-0000-4000-8000-000000000001", "status": "completed" }
```
→ 200
```json
[
  {
    "entity_id": "todo.shopping_list",
    "state": "1",
    "attributes": { "friendly_name": "Shopping List", "supported_features": 15 },
    "last_changed": "2026-09-30T05:00:00.000000+00:00",
    "last_reported": "2026-09-30T05:00:00.000000+00:00",
    "last_updated": "2026-09-30T05:00:00.000000+00:00",
    "context": { "id": "01J9ZZZZZZZZZZZZZZZZZZZZZY", "parent_id": null, "user_id": "abc123" }
  }
]
```

`POST /api/services/persistent_notification/create`, request:
```json
{ "title": "Dashboard", "message": "Skylight token needs re-auth", "notification_id": "dashboard_skylight_auth" }
```
→ 200 `[]`

`GET /api/calendars` → 200
```json
[ { "entity_id": "calendar.family", "name": "Family" } ]
```

`GET /api/calendars/calendar.family?start=2026-09-28T00:00:00Z&end=2026-10-05T00:00:00Z` → 200
```json
[
  {
    "start": { "date": "2026-10-02" },
    "end": { "date": "2026-10-03" },
    "summary": "School holiday",
    "description": null,
    "location": null,
    "uid": "holiday-2026-10-02@example",
    "recurrence_id": null,
    "rrule": null
  },
  {
    "start": { "dateTime": "2026-09-30T18:00:00-04:00" },
    "end": { "dateTime": "2026-09-30T19:30:00-04:00" },
    "summary": "Soccer practice",
    "description": "Bring water",
    "location": "Field 3",
    "uid": "evt-77",
    "recurrence_id": "20260930T220000Z",
    "rrule": "FREQ=WEEKLY;BYDAY=WE"
  }
]
```
`status` (`CalendarEventStatus`) may also appear as a key, and it can be `null`. **[V-src dataclass field. Whether it's always serialized depends on core version.]**

---

## 5. Web Push with VAPID (`web-push` npm)

### 5.1 Package facts **[V-src registry, 2026-09-30]**

- The latest published version is **`web-push@3.6.7`** (2024-01-16), with `engines.node >= 16`. The published package is **CommonJS** (`main: src/index.js`, no `"type"`). The repo's master branch has moved to ESM (`"type":"module"`), but that change is **unreleased**.
- Types come from `@types/web-push@3.6.4`.
- Dependencies: `http_ece`, `jws`, `asn1.js`, `https-proxy-agent`. They're all pure JS, so there are no native builds and it works on Node 22.

### 5.2 Usage on Node 22 **[V-src README + Inferred glue]**

```ts
// ESM/TS on Node 22: default-import the CJS module.
import webpush from "web-push";

// One-time: generate keys and store them as env secrets.
// npx web-push generate-vapid-keys --json   (CLI ships with the package)
webpush.setVapidDetails(
  "mailto:you@your-real-domain.com",       // must be a real mailto: or https: URI (Apple rejects localhost subjects)
  process.env.VAPID_PUBLIC_KEY!,           // URL-safe base64
  process.env.VAPID_PRIVATE_KEY!,
);

// subscription = PushSubscription.toJSON() from the browser:
// { endpoint, expirationTime, keys: { p256dh, auth } }
try {
  const res = await webpush.sendNotification(subscription, JSON.stringify(payload), {
    TTL: 60 * 60,          // seconds; default is 4 weeks
    urgency: "high",       // very-low | low | normal | high
    topic: "paperclip-pap-224", // ≤32 URL-safe base64 chars; replaces an undelivered msg with same topic
    timeout: 10_000,       // socket timeout (ms)
    // contentEncoding defaults to "aes128gcm"
    // proxy: process.env.HTTPS_PROXY  // if egress must go through a proxy
  });
  // res.statusCode is usually 201
} catch (err: any) {
  // err is a WebPushError with statusCode, headers, body, endpoint
  if (err.statusCode === 404 || err.statusCode === 410) {
    // subscription is gone: delete it from the DB
  } else if (err.statusCode === 429) {
    // back off per the Retry-After header
  } else if (err.statusCode === 413) {
    // payload too large: shrink it
  }
}
```

- The browser side calls `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: <VAPID public key as a Uint8Array> })`. **[V-src README]**
- `webpush.generateRequestDetails(sub, payload, opts)` builds the request without sending it. This is useful for contract tests that assert on headers such as `TTL`, `Urgency`, `Topic`, `Content-Encoding: aes128gcm`, and `Authorization: vapid t=…, k=…`. **[V-src README]**
- `setGCMAPIKey` is legacy and not needed. VAPID alone works for Chrome/FCM. **[Inferred, standard practice]**

### 5.3 Android Chrome delivery notes **[Inferred: general platform knowledge, not re-verified against Google docs here]**

- Chrome subscriptions use endpoints at `https://fcm.googleapis.com/fcm/send/...`. No Firebase project is needed with VAPID.
- **Always show a notification** in the service worker `push` handler, using `event.waitUntil(self.registration.showNotification(...))`. If you don't, Chrome shows a generic "This site has been updated in the background" notification, and repeated silent pushes can cost you the permission.
- Use **`urgency: "high"`** for time-sensitive alerts. `normal` and `low` may be deferred while the device is in Doze. **High-priority messages that never lead to a user-visible notification may be deprioritized by FCM over time.**
- Keep the payload small. After encryption the limit is about **4 KB**, and you get 413 above it. Send an id and title, and let the service worker or the click handler fetch the details.
- `TTL: 0` means "deliver now or drop", which is risky for phones that are offline. Use minutes to hours instead.
- Treat **404 and 410** as permanent, and prune the subscription. Subscriptions also silently die when the user clears site data or revokes permission.
- On Android 13+, the OS-level notification permission for Chrome must be granted in addition to the site permission. The site doesn't need to be installed as a PWA on Android, unlike iOS Safari, which requires a Home Screen web app. The site must be served over **HTTPS**, or `localhost` in dev.
- Test with Chrome DevTools → Application → Service Workers → "Push", and with `chrome://gcm-internals` on desktop.

Subscription fixture (from `PushSubscription.toJSON()`):
```json
{
  "endpoint": "https://fcm.googleapis.com/fcm/send/dGVzdC1lbmRwb2ludA:APA91bExample",
  "expirationTime": null,
  "keys": {
    "p256dh": "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
    "auth": "tBHItJI5svbpez7KI4CCXg"
  }
}
```
The `p256dh` (65-byte uncompressed P-256 point) and `auth` (16 bytes) values are well-formed-length placeholders, not a real subscription. **[Inferred]**

Push-service error fixture (what `err` carries on 410):
```json
{ "name": "WebPushError", "statusCode": 410, "headers": {}, "body": "push subscription has unsubscribed or expired.\n", "endpoint": "https://fcm.googleapis.com/fcm/send/dGVzdC1lbmRwb2ludA:APA91bExample" }
```
The exact FCM body text is illustrative, so assert on `statusCode` only. **[Inferred]**

---

## 6. Open questions / things to verify live before shipping

1. **Paperclip:** there was no live instance to test against, so everything above comes from source. Confirm the `identifier` format for your company prefix, and whether the dashboard's user is a company member. Board keys only see `companyIds` from memberships, unless the user is an instance admin or the instance runs in `local_trusted` mode.
2. **Skylight:** the whole API is unofficial. The login flow changed in 2026 (sessions were retired). Pin `skylight-api-version`, expect breakage, and keep the adapter behind a feature flag with clear "re-auth needed" UX.
3. **Todoist:** confirm the recurring-task snooze semantics (§3.3 caveat) with a throwaway task.
4. **Home Assistant:** reading persistent notifications needs WebSocket, not REST. The to-do panel deep-link URL is unverified.
5. **Web Push:** `web-push` hasn't had a release since 2024-01. If an ESM-only 4.x ships, the import stays `import webpush from "web-push"`, but re-check the typings.
