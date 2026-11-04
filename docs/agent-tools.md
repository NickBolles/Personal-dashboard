# Agent tools: scoped agent tokens + Jarvis MCP

Jarvis exposes the owner's work (areas → projects → items) to a Hermes agent profile through an
MCP server at **`POST /api/mcp`** (streamable HTTP, JSON responses). Access is a **scoped agent
token** the owner mints in **Settings → Agents → Agent access**. The proposal is in
`/opt/data/worktrees/jarvis-cos-in-jarvis-proposal.md` (PR 2).

## Rules (enforced on the server, not in the prompt)

- **Tokens only work on `/api/mcp`.** `resolveUser` never accepts an agent token, so it can't call
  other `/api` routes. `/api/mcp` takes nothing else: no cookies, no proxy identity, no device tokens.
- **The owner, narrowed.** A token acts for the owner who minted it. Its capabilities are its scopes
  ∩ the owner's (`work.use`, plus `hermes.chat` for filing). It never gets `finance.*` or `admin`.
  If ownership moves or the account is disabled, the token stops working.
- **Finance is never readable or writable.** No tool touches Finance data. Finance areas and areas
  with `aiPolicy: excluded`, including everything under them, are invisible. An id there answers
  `not_found`, the same as an id that doesn't exist. Archived items are hidden too.
- **Never settle.** `jarvis_update_item` refuses `settled`, `abandoned` and `superseded`. No tool
  settles, archives, moves, splits, merges or deletes. Those go through `jarvis_request_change`,
  which only raises a **Needs you** decision ("@profile proposes: archive …") for the owner.
- **Every write is attributed, logged and undoable.** Tools call the normal store functions inside
  `withVia("agent:<profile>")` (`server/work/actor.ts`). That gives:
  - `work_events.via` and `work_ops.via` are set;
  - `work_items.created_via` and `updated_via` are set (an owner edit clears `updated_via`);
  - Activity shows **by @profile**, and items show **created/updated by @profile**;
  - `audit_log` gets `agent.mcp` rows (actor `agent:<profile>`, tool, result; never the arguments or the token).

  Creates record a `create` undo op: undo removes the item if it's untouched, otherwise archives it.
  Edits record the normal `edit` op. Agent ops stay undoable from Activity for **7 days**, not the
  usual 10 minutes.

- **Limits.** 120 calls/min per token. The request body is capped at 64 KB. Every tool input is
  validated by a strict zod schema (titles ≤200 chars, summaries ≤8000, at most 6 choices, …).
  Bad tokens count toward the sign-in throttle (`ip:agent:<ip>`). A browser `Origin` other than
  Jarvis' own is refused (DNS-rebinding guard).
- **No outbound fetches.** `jarvis_link` stores https / GitHub URLs without fetching them (no SSRF),
  and `prUrl` must be a GitHub pull-request URL.
- **Kill switch.** Revoke the token in Settings → Agents → Agent access. The next call gets 401.

## Scopes

| Scope                | Lets the agent                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `work.read`          | `jarvis_tree`, `jarvis_search`, `jarvis_get_item`, `jarvis_list_decisions`                              |
| `work.write`         | `jarvis_create_item`, `jarvis_update_item`, `jarvis_add_note`, `jarvis_link`, `jarvis_add_quick_action` |
| `decisions.write`    | `jarvis_raise_decision`, `jarvis_request_change`                                                        |
| `runs.write`         | `jarvis_run_start`, `jarvis_run_update`                                                                 |
| `conversations.file` | `jarvis_file_conversation` (also needs a route for the profile in Settings → Agents)                    |

`tools/list` returns only the tools the token's scopes allow.

`jarvis_add_quick_action` (scope `work.write`) accepts `{label, prompt, scope?}`
(label ≤60, prompt ≤2000; scope `global`, `area:<id>` or `page:<path>`). It only
creates a `proposed` quick action attributed to `agent:<profile>` through
`withVia` and the work-op Undo stack. It returns
`{proposed:true, id, note:"The owner must tap Add"}`. Finance/AI-excluded area
scopes and Finance page scopes are refused. Only the owner-facing API can
accept (optionally with edits) or dismiss it. Accepting never sends a prompt;
tapping a saved chip only fills the composer. The owner still taps Send.

## Tools

| Tool                       | Params                                                                                                                    | Notes                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `jarvis_tree`              | `areaId?`, `depth? 1–4`, `includeClosed?`                                                                                 | areas → projects → items: status, next action, assignee, open decision (≤400 nodes)                                                                          |
| `jarvis_search`            | `q`                                                                                                                       | title / next action / summary words, ≤25 hits with path                                                                                                      |
| `jarvis_get_item`          | `id`                                                                                                                      | fields, summary, children, links, decision, agent runs, last 10 activity rows                                                                                |
| `jarvis_create_item`       | `parentId`, `title`, `kind? project\|thread\|investigation\|note`, `summary?`, `nextAction?`, `assignee?`                 | no areas; returns `undoOpId`                                                                                                                                 |
| `jarvis_update_item`       | `id`, `title?`, `summary?`, `nextAction?`, `status?`, `reason?`, `assignee?`, `tags?`, `startDate?`, `targetDate?`        | partial; settle/abandon/supersede refused                                                                                                                    |
| `jarvis_add_note`          | `itemId`, `title`, `body?`                                                                                                | a note child item                                                                                                                                            |
| `jarvis_link`              | `itemId`, `url`, `title?`, `kind? pr\|issue\|url`                                                                         | GitHub PR/issue or https URL (e.g. an artifacts board)                                                                                                       |
| `jarvis_add_quick_action`  | `label`, `prompt`, `scope?`                                                                                               | Proposed saved prompt only; the owner must tap Add. Never sends or activates.                                                                                |
| `jarvis_raise_decision`    | `itemId`, `question`, `choices?` (≤6)                                                                                     | shows in Needs you; one open decision per item                                                                                                               |
| `jarvis_request_change`    | `itemId`, `op settle\|archive\|move\|split\|merge\|delete\|abandon`, `reason`, `targetId?`                                | proposal only; nothing changes                                                                                                                               |
| `jarvis_list_decisions`    | —                                                                                                                         | open item decisions                                                                                                                                          |
| `jarvis_file_conversation` | `sessionId`, `itemId`                                                                                                     | adopts the agent's own session (on the token's profile) and files it; Bot Chat / hidden / sub-agent sessions refused                                         |
| `jarvis_run_start`         | `itemId`, `title`, `hermesSessionId?`, `delegationId?`, `transcriptPath?`                                                 | registers a run, shown in the item's Agent panel and the Agents strip; idempotent per `delegationId` (a retry returns the same `runId`, `existing: true`)    |
| `jarvis_run_update`        | `runId`, `state running\|waiting\|done\|failed`, `summary?`, `prUrl?`, `hermesSessionId?`, `transcriptPath?`, `children?` | only the agent that started it; every call is a heartbeat; `children` = `[{title, state, summary?}]` (≤20, replaces the list); done/failed posts to Activity |

Tool errors come back as MCP tool results with `isError: true` and `{error, message}` (for example
`not_found`, `forbidden`, `owner_only`, `validation`, `decision_open` or `rate_limited`). They are
not JSON-RPC errors.

Suggested coordinator flow: `jarvis_run_start` → `delegate_task`. When the delegation completes:
`jarvis_run_update(done, summary, prUrl)`, then `jarvis_link(pr)`, then
`jarvis_update_item(status, nextAction)`.

## Delegations (PR 3)

- **Register every delegation** as a run on the item it serves: `jarvis_run_start({itemId, title, delegationId, hermesSessionId?, transcriptPath?})`. Pass your own delegation/batch id as `delegationId`, so a retry after a timeout returns the same run instead of a duplicate.
- **Heartbeat:** any `jarvis_run_update` counts. A run still `running` with no update for **30 min** (`STALL_AFTER_MIN`, lib/agent-runs.ts) shows a **Stalled** badge on the item's Agent panel and the Agents strip, and a "Stalled" entry in **Needs you** linking to the item. Nothing is changed automatically: the run stays `running` until the agent or the owner acts.
- **Children:** on a batch result, send `children` (one `{title, state, summary}` per sub-agent) with the parent run's summary and `prUrl`. Jarvis shows them under the run.
- **Transcript path / Hermes session / delegation id** are shown as copyable text. Jarvis never opens the path or fetches the session.
- **Wording:** a run state `waiting` reads "Waiting". The label "Waiting for approval" appears only when a Jarvis-started Hermes run or AI job is actually paused on a pending approval.

## Connecting a Hermes profile (owner step C)

This changes Hermes config and adds a secret, so the owner does it. Jarvis code never changes
Hermes config.

1. **Mint the token.** Jarvis → Settings → Agents → Agent access:
   - Name "Chief of staff", profile `chiefofstaff`, scopes as needed (default: everything but filing).
   - **Create token**, then **Copy**. It is shown once; Jarvis stores only its hash.
2. **Put the token in the profile env.** Add one line to `~/.hermes/profiles/chiefofstaff/.env`:
   ```
   JARVIS_MCP_TOKEN=<paste>
   ```
3. **Add the server to the profile config.** In `~/.hermes/profiles/chiefofstaff/config.yaml`:
   ```yaml
   mcp_servers:
     jarvis:
       url: "https://jarvis.nickbolles.com/api/mcp"
       headers:
         Authorization: "Bearer ${JARVIS_MCP_TOKEN}"
       timeout: 60
   ```
   If env interpolation isn't available in your Hermes version, paste the token in place of
   `${JARVIS_MCP_TOKEN}`. The config file then holds a secret, so keep it at mode 600.
4. **Restart.** Start a new chiefofstaff session; the gateway may need a restart window to pick up
   new MCP servers.
5. **Check it works.**
   - Ask the agent to call `jarvis_tree`. It should list your areas, without Finance.
   - Then ask it to create a test item under Portfolio. In Jarvis → Activity, the row reads "by @chiefofstaff" with Undo.
   - Undo it.
6. **Kill switch.** Settings → Agents → Agent access → **Revoke…**.

A signed-out probe must answer with Jarvis' own 401:

```
curl -s -X POST https://jarvis.nickbolles.com/api/mcp -d '{}'
→ {"error":"Agent token required","code":"unauthenticated"}
```

## Code map

- `lib/agent-access.ts`: scopes, labels, mint schema
- `server/agent-access/tokens.ts`: mint / list / revoke, hash lookup, scope → caps, rate limit
- `server/agent-access/tools.ts`: tool definitions and the visibility filter (`agentItems`)
- `server/agent-access/mcp.ts`: JSON-RPC handling (initialize, ping, tools/list, tools/call) and auditing
- `app/api/mcp/route.ts`: transport and auth
- `app/api/settings/agents/tokens/**`: owner UI API (admin)
- `server/work/actor.ts`: `withVia` / `currentVia`
- Migration `0034_agent_access`: `agent_tokens`, `agent_runs`, plus the `via` / `created_via` / `updated_via` columns
- UI:
  - `components/agents/AgentAccessCard.tsx`
  - `components/work/AgentChip.tsx`
  - Agent panel runs list in `components/agents/AgentRuns.tsx`
- Tests: `test/agent-access.test.ts`, `e2e/agent-access.spec.ts`
