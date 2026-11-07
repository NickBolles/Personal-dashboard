# Phase 3 Worker A handoff

Branch: wip/p3-gaps
Worktree: /opt/data/worktrees/jarvis-phase3-wA
Base: 58da76f

Implementation is locally verified, not browser-verified. Per the common rules, no build, Playwright, install, push, merge or deployment was run. No DB migration. No new spend tables. No edits to Smart UI, coordinator, Areas tree/map/graph, or Today worker-owned files. The actual item workspace is app/(shell)/areas/WorkView.tsx (not components/work/WorkView.tsx); its diff is only two imports, an overflow-menu spread and the two component mounts.

## Findings

S4 — Done (local implementation)

- Theme System/Light/Dark and Density Auto/Touch/Comfortable/Compact apply immediately through existing theme setters. Reads saved preferences and syncs tab/storage changes.
- Files: app/(shell)/settings/AppearanceCard.tsx, SettingsView.tsx; test/appearance-card.test.tsx. Uses existing lib/client/theme.ts without changing storage contracts.

S2 — Done (local implementation; browser reflow/visibility verification pending)

- Shared section list; sub-page shell has no added h1, marks current link aria-current=page and labels navigation Settings sections. Index keeps its existing nav. Sub-page nav requires viewport >=1024 AND container >=720, so the shell accounts for the global sidebar while hiding navigation on phones.
- Files: app/(shell)/settings/{layout.tsx,SettingsShell.tsx,sections.ts,SettingsView.tsx}; test/settings-shell.test.tsx; e2e/a11y.spec.ts.
- Existing settings e2e link-name queries were reviewed; no existing strict link-name query needed a scope change.

S1 — Partial (autonomy mode is not represented in the current data model)

- Coordinator card lists each configured profile route, linked covered areas, configured profile value, today/7-local-day AI job spend, shared daily budget meter once, no-schedule copy, active token scopes, and locked always-ask policies.
- ai_jobs DOES have hermesProfile attribution. Spend uses only that attribution, never infers old spend from an area's current route. Excludes unfinished jobs and other users; labels estimates including estimates already copied into costUsd. Does not imply chat/subscription usage or a separate per-profile allowance. Revoking/minting a token invalidates coordinator scopes; spend polls every 30s.
- Area settings.agentMode is the Hermes PROFILE STRING, not Propose / Act-on-low-risk permission. The UI links it to its area and explicitly says the autonomy policy is not configured. It does not manufacture permissions.
- Files: components/agents/{CoordinatorsCard.tsx,AgentsSettingsView.tsx,AgentAccessCard.tsx}; lib/coordinator-settings.ts; server/agents/coordinators.ts; app/api/settings/agents/coordinators/route.ts; test/coordinator-settings.test.ts.

AL1 — Done (local implementation; mobile e2e pending)

- Alerts / Approvals segmented control and pending-decision count/list. Dedicated decision detail with question, options, context links, confirmed item answer via the existing API, and Undo. Approval/workflow decisions link to their existing approval/review flows; no alternate approval writer.
- Stable route id is the encoded DecisionEntry.key, e.g. /decisions/item%3Awk_..., /decisions/approval%3Arun_.... Strict key validation rejects slashes, dots, extra colons, whitespace, trailing newline and oversized ids. Missing/invalid decisions use kit EmptyState.
- Existing /decisions is unchanged. Approval push links use the detail route when the stable run key exists. Hidden AI jobs retain their existing chat fallback.
- Files: app/(shell)/alerts/AlertsView.tsx; app/(shell)/decisions/[id]/page.tsx; app/api/work/decisions/[id]/route.ts; components/decisions/{DecisionDetail.tsx,DecisionAnswer.tsx}; lib/decision-route.ts; server/{worker/index.ts,ai/runner.ts}; test/{decision-route.test.ts,decisions-detail-api.test.ts,decision-answer.test.tsx}; e2e/approvals-route.spec.ts.

IT1 — Done (local implementation)

- Warn banner immediately after NEXT. Agent-raised open question wins; otherwise newest eligible stalled/failed run, suppressing an old failure superseded by a newer run from the same profile. Up to three choices open the decision review flow, never write on click. Open run links/scrolls to actual run context; Ask again opens the existing Continue dialog (review draft, send separately).
- Attribution comes from the decision-request activity event, NOT the latest item editor/assignee. A later edit does not erase the original asker.
- Files: components/work/EscalationBanner.tsx; lib/{item-escalation.ts,decisions.ts}; server/work/decisions.ts; minimal app/(shell)/areas/WorkView.tsx insertion; test/{item-escalation.test.ts,agent-access.test.ts}.

TK1 — Partial (native upstream creation remains unsupported)

- URL-persisted All / Mine / Waiting with original due/completed groups preserved, plus a group for actual waiting statuses. All includes other people's chores. Mine means explicitly mine or unassigned personal todos; Waiting includes unclaimed/other-assigned open tasks and waiting status. AI is hidden with an explanation: NextAction has neither agent assignees nor creator provenance.
- Header New task focuses the existing local Jarvis add form; it is disabled for external canonical providers because their existing API has no task-creation flow. No new upstream write path was invented. Existing Add is secondary so the header is the primary.
- Files: app/(shell)/todos/TodosView.tsx; lib/task-segments.ts; test/task-segments.test.ts; components/skylight/SkylightViews.test.tsx; e2e/task-segments.spec.ts.

IT2 — Partial (no existing Summarize handler)

- New Draft next step / Split / Move shortcut component reuses the same existing menu callbacks, preserves menu entries and uses accessible names AI: .... Hidden at <=412. Existing policy/capability gate hides all shortcuts on excluded items. Existing Research/Plan/Schedule/Draft action row remains intact.
- No Summarize action exists in the menu/API; not mapped deceptively to research or plan.
- Files: components/work/ItemAiChips.tsx; minimal app/(shell)/areas/WorkView.tsx changes; test/phase3-shortcuts.test.tsx.

C3 — Done (local implementation)

- Real, muted, data-dynamic paragraph under the composer at >=640. Lists @ context, # PR, / command (all actually supported by ComposerPicker) and platform-aware Ctrl/Command+Enter send using existing useModKey's post-hydration platform detection. Hidden while approval/clarification makes the composer compact.
- File: components/chat/Conversation.tsx. No composer handlers changed.

CP1 — Done (local implementation)

- Live Will create preview with capture icon, actual API-derived title (first line / URL host / Screenshot fallback) and Inbox destination. Capture has no due parser or area/project picker, so no invented date or path is shown. Existing labels remain.
- Files: components/capture/{CaptureSheet.tsx,CapturePreview.tsx}; test/phase3-shortcuts.test.tsx.

G6 — Partial (bounded sweep, not all requested pages)

- Kit empty states in agent routes, shared conversations, Skylight chore/list/event sections, House exceptions/controls and workflow list. Workflow loading uses skeletons; workflow failure has error Banner + Retry. Agents loading/error retains exactly one h1.
- Existing strings preserved. Remaining plain-text states in other settings sub-pages, people, workouts and finance were not swept.
- Files: components/agents/AgentsSettingsView.tsx; app/(shell)/settings/SharedConversations.tsx; app/(shell)/skylight/SkylightView.tsx; app/(shell)/home-control/HomeControlView.tsx; components/workflows/WorkflowsGallery.tsx.

FI1 — Skipped

- Prioritized P1/core UI and verification; no finance fixture or snapshot changes made.

O1 — Skipped

- No speculative dynamic boundaries or performance claims without bundle/build verification. Current workout/finance views do not import standalone chart components to trivially split. Left for a measured performance pass.

O4 — Partial (specs ready, PNG baselines not recorded)

- Existing settings/todos/people/house/workouts page shots and Raycast palette shots already run on desktop and mobile; no duplicates added.
- Appended full Settings/Agents and desktop Appearance-card tests. Every fetched list for the new shots is fixture-owned. Added a default coordinator fixture to avoid the new request leaking real/shared DB lists into the existing agent-access shot.
- Files: e2e/visual.spec.ts; e2e/fixtures/phase3-gaps.ts.

## E2E / visual handoff (written, NOT run)

New: e2e/approvals-route.spec.ts

- alder approvals tab opens a decision deep link and reviews an option without writes
- alder missing decision shows the kit empty state

New: e2e/task-segments.spec.ts

- alder task segments persist in URL, retain due groups, and focus the existing add form

Changed: e2e/a11y.spec.ts

- alder settings appearance + sub-page section nav: one h1, current section and 200% reflow

Changed: e2e/visual.spec.ts (tests appended at end)

- visual: coordinators settings page (light)
- visual: coordinators settings page (dark)
  Screenshots settings-agents-coordinators-{light,dark}.png on desktop, mobile 412 and mobile-320.
- visual: appearance settings card (light)
- visual: appearance settings card (dark)
  Screenshots settings-appearance-{light,dark}.png, desktop only.

Existing alert/task/settings/chat desktop and changed empty-state snapshots will also need review/re-recording. No PNG files generated in this worktree.

Suggested integrator commands:

- npm run test:e2e -- e2e/approvals-route.spec.ts e2e/task-segments.spec.ts --project=mobile
- npm run test:e2e -- e2e/a11y.spec.ts --grep 'alder settings'
- npm run test:e2e -- e2e/visual.spec.ts --grep 'coordinators settings page|appearance settings card'
- Follow the existing pinned-container visual-baseline workflow when recording PNGs; then run the broader suite/build.

## Verified local checks

- nice -n 19 npx tsc --noEmit -p .: passed.
- ESLint on every new/changed TS/TSX file: exit 0, no errors. Four existing SettingsView warnings remain (set-state-in-effect and three location assignments); no new warnings.
- Prettier --check on every new/changed TS/TSX file: passed.
- git diff --check: passed.
- Consolidated Vitest: 20 files passed, 158 tests passed. Exact command:

  env -u HA_BASE_URL -u HA_TOKEN -u HERMES_API_KEY -u HERMES_BASE_URL -u PAPERCLIP_API_KEY -u PAPERCLIP_API_URL -u PAPERCLIP_BASE_URL -u SKYLIGHT_REFRESH_TOKEN -u GH_TOKEN -u GITHUB_TOKEN -u MONARCH_TOKEN -u MONARCH_API_URL -u GOOGLE_CLIENT_ID -u GOOGLE_CLIENT_SECRET npx vitest run test/appearance-card.test.tsx test/coordinator-settings.test.ts test/settings-shell.test.tsx test/theme.test.ts test/task-segments.test.ts test/item-escalation.test.ts test/decision-route.test.ts test/decisions-detail-api.test.ts test/phase3-shortcuts.test.tsx test/decision-answer.test.tsx test/agent-access.test.ts test/ai-rules.test.ts test/agent-runs.test.ts test/work-from-jarvis.test.ts test/ai-runner.test.ts test/mobile.test.ts components/skylight/SkylightViews.test.tsx test/areas.test.ts components/ui/kit.test.tsx test/workflows-builder.test.ts

Regression coverage includes the existing finance/AI import guard, AI runner, decisions aggregation, scoped agent access/provenance, mobile contracts, Skylight views and workflow builder rules. Tests use isolated databases and mocked/local upstreams, not production writes.
