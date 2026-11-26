# Atlas copy inventory

Inventory captured before copy edits from `git grep -n -i jarvis` on `feat/atlas-brand` at `main 3e99d2fe`.

## Scope and classification

- `product-facing`: runtime UI, accessibility, notification/push fallback, install/onboarding, and user-visible errors; replace proper-name `Jarvis` with `Atlas`.
- `intentional internals`: identifiers, lower-case `jarvis` namespaces, routes/events/env/auth/storage/database/service-worker keys, Android package/cert/host identifiers, historical records/fixtures, and `lib/jarvis-ui` catalog material; do not rename.
- `compatibility`: the exact `Context from Jarvis:` delimiter and its parser remain unchanged so stored/outgoing historical chat context stays readable. The user-visible explanatory label may say Atlas.
- `external identity`: Google/GitHub third-party grant/app names remain honest where the remote registration still says Jarvis.
- Excluded from this lane: generated/legal/history docs, protected `AGENTS.md`/`CLAUDE.md`, parent-owned brand/assets/metadata/settings About work, and `jarvis-ui` fenced catalog.

## Original source hits: product-facing candidates

### `android/app/src/main/AndroidManifest.xml`

- L16 — product-facing: `android:theme="@style/Theme.Jarvis">`
- L30 — product-facing: `android:theme="@style/Theme.Jarvis.Launcher">`
- L49 — product-facing: `<!-- App Links: Jarvis links elsewhere on the phone open the app (verified by the site's assetlinks.json). -->`
- L77 — product-facing: `<!-- Share text or a link to Jarvis → Ask Hermes with it -->`
- L88 — product-facing: `android:theme="@style/Theme.Jarvis">`

### `android/app/src/main/java/com/nickbolles/jarvis/data/AppGraph.kt`

- L40 — product-facing: `val p = store.current() ?: throw ApiException(401, "unpaired", "This phone isn't paired with Jarvis")`
- L50 — product-facing: `if (e.isAuth && e.code != "unpaired") signOutLocally("Jarvis signed this phone out. Pair it again from Settings → Phones.")`

### `android/app/src/main/java/com/nickbolles/jarvis/data/JarvisApi.kt`

- L76 — product-facing: `throw ApiException(0, "network", "Can't reach Jarvis (${e.message ?: "network error"})")`
- L82 — product-facing: `throw ApiException(r.code, err?.code, err?.error ?: "Jarvis returned ${r.code}")`
- L87 — product-facing: `throw ApiException(r.code, "bad_response", "Unexpected response from Jarvis")`
- L125 — product-facing: `* Jarvis-local: it changes this person's ranking, never the item in its source.`
- L227 — product-facing: `throw ApiException(0, "network", "Can't reach Jarvis (${e.message ?: "network error"})")`

### `android/app/src/main/java/com/nickbolles/jarvis/push/NotificationActionReceiver.kt`

- L10 — product-facing: `/** "Mark handled" on a notification: tells Jarvis (alert → acted), then clears it. */`

### `android/app/src/main/java/com/nickbolles/jarvis/push/Notifications.kt`

- L14 — product-facing: `/** Builds phone notifications from Jarvis's FCM data messages. */`
- L63 — product-facing: `.setContentTitle(data["title"] ?: "Jarvis")`

### `android/app/src/main/java/com/nickbolles/jarvis/push/PushRegistrar.kt`

- L20 — product-facing: `* with anyone's Jarvis. Registration sends the FCM token to /api/devices/me.`

### `android/app/src/main/java/com/nickbolles/jarvis/ui/components/Format.kt`

- L38 — product-facing: `"jarvis" to "Jarvis",`

### `android/app/src/main/java/com/nickbolles/jarvis/ui/nav/JarvisRoot.kt`

- L169 — product-facing: `else -> Routes.fromPath(href)?.let { navigate(it) } ?: message("That opens in Jarvis on the web")`

### `android/app/src/main/java/com/nickbolles/jarvis/ui/screens/CaptureSheet.kt`

- L68 — product-facing: `"Tap a chip to attach what Jarvis knows right now (calendar, chores, home state…).",`

### `android/app/src/main/java/com/nickbolles/jarvis/ui/screens/ChatScreens.kt`

- L348 — product-facing: `"Shared with you, read only. Fork it in Jarvis on the web to continue it as your own.",`

### `android/app/src/main/java/com/nickbolles/jarvis/ui/screens/ControlsScreen.kt`

- L229 — product-facing: `if (doorControls && controls.data != null && list.isEmpty()) item { EmptyState("No controls allowed", "Add entities to “Allowed controls” in Jarvis on the web (Settings → Connections → Home Assistant).") }`
- L271 — product-facing: `text = { Text("Current state: ${c.state}. Jarvis checks that it hasn't changed, then waits for Home Assistant to confirm.") },`

### `android/app/src/main/java/com/nickbolles/jarvis/ui/screens/HomeScreen.kt`

- L296 — product-facing: `EmptyState("No sources connected yet", "Connect Hermes, todos, Home Assistant and more from Jarvis on the web (Settings → Connections).")`

### `android/app/src/main/java/com/nickbolles/jarvis/ui/screens/PairScreen.kt`

- L119 — product-facing: `if (l == null) error = "That QR code isn't a Jarvis pairing code" else {`
- L148 — product-facing: `Text("Connect to Jarvis", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.semantics { heading() })`
- L150 — product-facing: `"In Jarvis on the web, open Settings → Phones → Show pairing code. Then scan the QR code here.",`
- L184 — product-facing: `"Jarvis stores a revocable token for this phone. Sign it out any time from this app or from Settings → Phones on the web.",`

### `android/app/src/main/java/com/nickbolles/jarvis/ui/screens/SearchFinanceScreens.kt`

- L131 — product-facing: `label = { Text("Search Jarvis") },`
- L333 — product-facing: `"Jarvis plans and records; it never moves money. Plan payments, close check-ins and edit the long-term plan on the web.",`

### `android/app/src/main/java/com/nickbolles/jarvis/ui/screens/SettingsScreens.kt`

- L198 — product-facing: `text = { Text("Jarvis forgets this phone and stops sending it notifications. You can pair it again any time.") },`
- L234 — product-facing: `ToggleRow("Colors from my wallpaper", "Material You. Off uses Jarvis blue.", layout.dynamicColor) { onLayout(layout.copy(dynamicColor = it)) }`
- L246 — product-facing: `!notificationsAllowed -> "Notifications are turned off for Jarvis on this phone."`
- L247 — product-facing: `push == null && me.data != null -> "Phone notifications aren't set up on the server yet. In Jarvis on the web: Settings → Phones → Firebase."`
- L248 — product-facing: `me.data?.device?.pushEnabled == true -> "This phone gets Jarvis notifications."`
- L253 — product-facing: `Text("Quiet hours and categories are in Jarvis on the web (Settings → Notifications).", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)`
- L273 — product-facing: `"Connections, integrations and pairing other phones are managed in Jarvis on the web.",`
- L329 — product-facing: `item { Text("Order and show the sections of Home. Jarvis on the web uses the same layout.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }`

### `android/app/src/main/java/com/nickbolles/jarvis/ui/screens/SourceScreens.kt`

- L103 — product-facing: `st != null && st.state == "unconfigured" -> item { EmptyState("${st.label} isn't connected", "Connect it from Jarvis on the web: Settings → Connections.") }`
- L282 — product-facing: `if (d != null && !d.enabled) item { EmptyState("Daily Compass isn't set up", "Set it up from Jarvis on the web: Settings → Connections.") }`

### `android/app/src/main/java/com/nickbolles/jarvis/web/TwaLauncherActivity.kt`

- L22 — product-facing: `* The app's launcher: opens the Jarvis web app full screen in Chrome (Trusted Web Activity).`

### `android/app/src/main/java/com/nickbolles/jarvis/widgets/Widgets.kt`

- L86 — product-facing: `Title("Jarvis")`
- L88 — product-facing: `Text("Open Jarvis to connect this phone", style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 14.sp))`
- L128 — product-facing: `summary == null -> Text("Open Jarvis to load", style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant))`
- L201 — product-facing: `summary == null -> Text("Open Jarvis to load", style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant))`
- L278 — product-facing: `c == null -> if (summary == null) "Open Jarvis to load" else "Not set up"`
- L328 — product-facing: `work == null -> Text("Open Areas in Jarvis to load", style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant))`

### `android/app/src/main/res/values-night/themes.xml`

- L3 — product-facing: `<style name="Theme.Jarvis" parent="android:Theme.Material.NoActionBar">`

### `android/app/src/main/res/values/strings.xml`

- L3 — product-facing: `<string name="app_name">Jarvis</string>`
- L19 — product-facing: `<string name="classic_app">Jarvis classic</string>`

### `android/app/src/main/res/values/themes.xml`

- L4 — product-facing: `<style name="Theme.Jarvis" parent="android:Theme.Material.Light.NoActionBar">`
- L10 — product-facing: `<style name="Theme.Jarvis.Launcher" parent="android:Theme.Translucent.NoTitleBar">`

### `app/(shell)/areas/WorkView.tsx`

- L2639 — product-facing: `description={kind === "github_pr" ? "Jarvis only reads PR state; it never writes to GitHub." : undefined}`

### `app/(shell)/areas/dashboard/DashboardView.tsx`

- L84 — product-facing: `subtitle="Your work at a glance. Widgets read Jarvis work data only."`
- L615 — product-facing: `hint={\`Runs in a sandboxed frame with no network access, cookies or Jarvis APIs. ${Math.ceil(htmlBytes / 1024)} of 100 KB.\`}`

### `app/(shell)/dev/kit/KitGallery.tsx`

- L175 — product-facing: `<Orb expanded={orb} onClick={() => setOrb((o) => !o)} label={\`Jarvis commands (${t})\`} />`

### `app/(shell)/finance/FinanceOverviewView.tsx`

- L37 — product-facing: `<PageHeader title="Finance" subtitle="Plans and records. Jarvis never moves money." />`
- L47 — product-facing: `subtitle="Plans and records. Jarvis never moves money."`

### `app/(shell)/finance/checkin/[id]/CheckinView.tsx`

- L181 — product-facing: `description="Plans and records only. Jarvis never moves money."`

### `app/(shell)/home-control/HomeControlView.tsx`

- L115 — product-facing: `<Banner tone="wn">Controls are disabled while offline. Jarvis never queues physical actions; they’ll re-enable after a fresh state check.</Banner>`
- L670 — product-facing: `* Counts only. Anything Jarvis couldn't read is "unknown", never 0. When the`
- L727 — product-facing: `const lines = [\`Home Assistant snapshot from Jarvis at ${time(new Date().toISOString())}:\`];`

### `app/(shell)/initiatives/InitiativesView.tsx`

- L43 — product-facing: `subtitle="Paperclip owns status, blockers and assignments. Jarvis shows them and links conversations."`

### `app/(shell)/settings/brief/BriefSettingsView.tsx`

- L223 — product-facing: `<ul className="space-y-1.5" aria-label="Proposed by Jarvis">`
- L242 — product-facing: `<ul className="divide-y divide-line" aria-label="Notes Jarvis uses">`

### `app/(shell)/settings/connections/ConnectionsView.tsx`

- L22 — product-facing: `<PageHeader title="Connections" subtitle="Credentials stay on the Jarvis server, encrypted at rest." />`
- L101 — product-facing: `tagline="World English Bible verse text on this Jarvis: off until you download it"`

### `app/(shell)/settings/home/HomeTuningView.tsx`

- L265 — product-facing: `"Help me tune what my Jarvis Home shows first. Read-only: don’t change anything. Suggest specific changes to my category settings or saved dates, and I’ll apply them myself.",`

### `app/(shell)/settings/phones/PhonesView.tsx`

- L61 — product-facing: `<PageHeader title="Phones" subtitle="The Jarvis Android app: pair it, see where you're signed in, set up notifications." />`
- L66 — product-facing: `In the Jarvis app, tap <strong>Scan pairing code</strong> and point it at the QR code, or type the server address and code by hand. Codes work once`
- L156 — product-facing: `hint={push.data?.serviceAccount ? "Saved (encrypted). Paste again to replace." : "Stored encrypted on the Jarvis server; never sent to the phone."}`

### `app/(shell)/settings/sections.ts`

- L14 — product-facing: `{ href: "/settings/phones", label: "Phones", desc: "Pair the Jarvis Android app, phone notifications" },`

### `app/(shell)/todos/TodosView.tsx`

- L126 — product-facing: `provider ? \`Canonical list: ${provider === "google_tasks" ? "Google Tasks" : provider === "home_assistant" ? "Home Assistant" : "Jarvis"}\` : undefined`

### `app/(shell)/workouts/WorkoutView.tsx`

- L111 — product-facing: `? "Workout finished · saved privately in Jarvis"`
- L112 — product-facing: `: "Saved in Jarvis · ready to resume",`
- L159 — product-facing: `setNotice(\`${result.imported} imported · ${result.skipped} already present · saved in Jarvis\`);`
- L447 — product-facing: `{r.source ? " · Imported" : " · Jarvis"}`

### `app/api/brief/feedback/route.ts`

- L9 — product-facing: `* Jarvis only, and reversible: \`verdict: null\` clears it (the response carries`

### `app/api/devices/pairing/route.ts`

- L10 — product-facing: `if (user.via === "device") throw new HttpError(403, "forbidden", "Pair new phones from Jarvis on the web");`

### `app/api/devices/push-config/route.ts`

- L17 — product-facing: `if (user.via === "device") throw new HttpError(403, "forbidden", "Change push settings from Jarvis on the web");`

### `app/api/hermes/sessions/[id]/runs/route.ts`

- L62 — compatibility (retain delimiter): `const rawInput = context ? \`${body.input}\n\n---\nContext from Jarvis:\n${context}\` : body.input;`
- L77 — product-facing: `? [\`Jarvis area: ${area!.area.title}.\`, modeHint ? \`Agent mode: ${modeHint}.\` : "", s.instructions ?? ""].filter(Boolean).join(" ")`

### `app/api/hermes/sessions/adoptable/route.ts`

- L10 — product-facing: `* Sessions on one Hermes profile that Jarvis doesn't track yet (Adopt existing chat).`

### `app/api/mcp/route.ts`

- L19 — product-facing: `* and agent tokens are not accepted anywhere else. A browser Origin other than Jarvis' own is`

### `app/api/paperclip/links/[id]/route.ts`

- L4 — product-facing: `/** Removes only Jarvis' relationship record. Paperclip work is never closed or deleted. */`

### `app/api/smart/workflows/route.ts`

- L11 — product-facing: `/** The current Jarvis-built workflow surface (morning brief, week plan, PR card); \`rebuild\` starts a fresh one from current data. */`

### `app/api/work/tasks/route.ts`

- L10 — product-facing: `* (\`scope=all\`), one channel or one project (\`scope=<id>\`). One row per task; from Jarvis's own records only.`

### `app/join/JoinForm.tsx`

- L58 — product-facing: `<p className="text-sm font-medium text-accent">Jarvis</p>`

### `app/join/page.tsx`

- L6 — product-facing: `export const metadata = { title: "Join Jarvis" };`

### `app/login/LoginForm.tsx`

- L44 — product-facing: `<p className="text-sm font-medium text-accent">Jarvis</p>`
- L48 — product-facing: `<Field id="username" label="Your sign-in name" hint="Leave empty if you set up this Jarvis.">`

### `app/onboarding/page.tsx`

- L7 — product-facing: `export const metadata = { title: "Set up Jarvis" };`

### `components/BuildUpdate.tsx`

- L61 — product-facing: `<Toast message="Jarvis updated" action={{ label: "Reload", onClick: () => void reloadOntoNewBuild() }} />`

### `components/InstallPrompt.tsx`

- L62 — product-facing: `<li>Open Jarvis at its HTTPS address.</li>`
- L66 — product-facing: `<li>Open Jarvis from your home screen, then enable push in Settings → Notifications.</li>`

### `components/NotificationSetup.tsx`

- L67 — product-facing: `<Badge tone="ok">Notifications from the Jarvis app</Badge>`
- L96 — product-facing: `<p className="text-sm text-muted">Browsers only allow push (and app install) on HTTPS. Open Jarvis through its HTTPS address.</p>`

### `components/agents/AgentAccessCard.tsx`

- L136 — product-facing: `Lets a Hermes profile read and update your work through Jarvis MCP (<code>/api/mcp</code>). Its changes show &quot;by @profile&quot; and can be`

### `components/agents/ComposerTargetChip.tsx`

- L8 — product-facing: `* so the owner can ask plain Jarvis instead (and back). Outside Areas it is a quiet "Jarvis" label.`
- L13 — product-facing: `<span className={cx("chip shrink-0", className)} data-testid="composer-target" data-agent="Jarvis">`
- L14 — product-facing: `<span aria-hidden="true">✦</span> Jarvis`
- L18 — product-facing: `const label = target.switchedToJarvis ? \`Asking Jarvis. Switch to ${area}'s agent\` : \`Asking ${target.agent} in ${area}. Switch to Jarvis\`;`
- L33 — product-facing: `<span className="truncate font-semibold">{target.switchedToJarvis ? "Jarvis" : target.agent}</span>`

### `components/agents/CoordinatorsCard.tsx`

- L110 — product-facing: `<p>No active Jarvis access scopes granted.</p>`
- L112 — product-facing: `<p className="mt-1 text-xs text-muted">Granted Jarvis token scopes only; not a promise about tools outside Jarvis.</p>`

### `components/agents/WhileAwayCard.tsx`

- L175 — product-facing: `Skipped: {refused.intent} ({refused.intent === "deploy" ? "Jarvis never deploys" : refused.label})`

### `components/agents/useComposerTarget.tsx`

- L13 — product-facing: `* owner switched the chip back to plain Jarvis (reset whenever the page's node changes).`
- L47 — product-facing: `/** The owner's chip: switch this page's composer to plain Jarvis (or back to the area's agent). */`

### `components/areas/AreaSettings.tsx`

- L238 — product-facing: `: "Jarvis may add notes and threads, update next actions and file to Inbox, with Undo. Everything else asks you. Never settles, merges, deploys, spends or sends."}`

### `components/areas/PortfolioTab.tsx`

- L303 — product-facing: `<b>{c.create}</b> new · <b>{c.update}</b> updated · <b>{c.unchanged}</b> already in Jarvis · <b>{c.skip}</b> skipped · <b>{c.links}</b> links`
- L325 — product-facing: `<p className="text-[13px] text-muted">Everything on the board is already in Jarvis.</p>`

### `components/brief/BriefDeck.tsx`

- L27 — product-facing: `* What came of the sparkle on a row, from Jarvis' own records: under way, waiting`

### `components/brief/BriefInsights.tsx`

- L49 — product-facing: `label: \`Jarvis noticed: ${BRIEF_NOTE_KIND_LABEL[n.kind]}\`,`

### `components/brief/BriefSky.tsx`

- L119 — product-facing: `<span>Written by Jarvis</span>`
- L141 — product-facing: `<KSpinner /> {brief.source === "ai" ? "Rewriting your brief…" : "Jarvis is writing your brief…"}`

### `components/brief/BriefView.tsx`

- L46 — product-facing: `<ProposedBox label="Let Jarvis write your brief">`

### `components/brief/HomeBriefCard.tsx`

- L39 — product-facing: `<span className="eyebrow">{b.source === "ai" ? "Your brief, written by Jarvis" : "Your brief"}</span>`

### `components/brief/HomeSources.tsx`

- L48 — product-facing: `<span className="block">Offline: showing what Jarvis had {live.data ? relativeTime(live.data.generatedAt) : "at your last visit"}.</span>`

### `components/brief/sky.ts`

- L71 — product-facing: `* through the picks the person is. Facts only, from Jarvis' own data.`

### `components/capture/CaptureExtras.tsx`

- L126 — product-facing: `const investigate = useWorkMutation(() => api.post(\`/api/work/inbox/${encodeURIComponent(entry.id)}/investigate\`, {}), { ok: "Jarvis is looking into it" });`

### `components/capture/CaptureSheet.tsx`

- L166 — product-facing: `toast(triage === "queued" ? "Captured · Jarvis is looking into it" : "Captured to the inbox", "ok");`

### `components/capture/CaptureTokens.tsx`

- L102 — product-facing: `description="Shown once. Jarvis keeps only a hash."`

### `components/capture/CaptureTriageCard.tsx`

- L31 — product-facing: `<p className="mt-1 text-xs text-muted">Check it and settle when you&apos;re happy — Jarvis never settles on its own.</p>`

### `components/capture/CaptureTriageChip.test.tsx`

- L159 — product-facing: `vi.mocked(api.post).mockRejectedValueOnce(new Error("Couldn't reach Jarvis"));`
- L162 — product-facing: `await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't reach Jarvis", "danger"));`
- L188 — product-facing: `expect(card.textContent?.includes("Check it and settle when you're happy — Jarvis never settles on its own.")).toBe(state === "done");`
- L272 — product-facing: `for (const name of ["Skylight list items", "Skylight calendar events", "Jarvis to-dos"]) {`
- L283 — product-facing: `for (const name of ["Skylight list items", "Skylight calendar events", "Jarvis to-dos"]) {`
- L293 — product-facing: `["jarvisTask", "Jarvis to-dos"],`

### `components/chat/ChatThread.tsx`

- L1119 — product-facing: `\`${x.url} (opens in Jarvis; sign-in required, read-only for anyone it is shared with)\`,`

### `components/chat/Refinements.test.tsx`

- L37 — product-facing: `it("only links returned Jarvis item metadata and never treats proposals as completion", () => {`

### `components/chat/Timeline.tsx`

- L32 — compatibility (retain delimiter): `const CONTEXT_MARK = "\n\n---\nContext from Jarvis:";`
- L390 — product-facing: `<summary className="cursor-pointer">Context Jarvis attached</summary>`
- L499 — product-facing: `? "Queued — your message was sent. Jarvis is waiting for a free Hermes connection and shows the reply as soon as one opens."`

### `components/chat/things/ChatPanel.tsx`

- L78 — product-facing: `{!records.length && !allOk && !failed && execution ? <p className="text-muted">Nothing running that Jarvis knows of</p> : null}`

### `components/home/Feedback.tsx`

- L138 — product-facing: `title={target.kind === "assist" ? "What did Jarvis get wrong?" : "Why is this ranked wrong?"}`

### `components/home/TriageDialog.test.tsx`

- L50 — product-facing: `.mockRejectedValueOnce(new ApiError(0, "Couldn't reach Jarvis", "network"));`

### `components/integrations/BiblePackSettings.tsx`

- L66 — product-facing: `Download {mb} MB once from <span className="break-all">{s.sourceUrl}</span>? Jarvis checks it against the pinned checksum (version {s.version})`

### `components/integrations/DriveConnection.tsx`

- L27 — external identity (retain remote name): `? "Google Drive disconnected. Google access stays on because Google Tasks shares it; remove Jarvis in your Google account to revoke both."`
- L46 — product-facing: `Access: only files Jarvis creates (<code className="break-all">drive.file</code>). Jarvis can&apos;t read or change anything else in your Drive. This is`
- L52 — product-facing: `Not turned on for this Jarvis. The owner enables it on the server once the Google OAuth client allows the redirect{" "}`

### `components/integrations/GithubApp.tsx`

- L11 — product-facing: `* runs GitHub's manifest flow from this browser: Jarvis prepares the manifest`
- L86 — product-facing: `This page isn&apos;t served over https ({s.appSetup.origin}). GitHub can&apos;t deliver webhooks here; open Jarvis at its public https address (or set{" "}`
- L163 — product-facing: `<p className="text-muted">Jarvis checks the App ID and private key with GitHub before saving. Both secrets are write-only.</p>`
- L339 — external identity (retain remote name): `description="Jarvis deletes its keys and installation list. The App still exists on GitHub: delete it there (Settings → Developer settings → GitHub Apps) to revoke it."`
- L375 — product-facing: `label="Accounts Jarvis accepts"`

### `components/integrations/GithubConnections.tsx`

- L88 — product-facing: `<li>Pick the owner (your user or the organization) and the repositories Jarvis may read.</li>`
- L200 — product-facing: `description="Jarvis forgets the token. Links to this owner's PRs stop refreshing (unless JARVIS_GITHUB_TOKEN is set)."`
- L231 — product-facing: `description="Stored encrypted on the Jarvis server. It's never shown again after you save."`
- L293 — product-facing: `type <code>application/json</code>, this secret, and the events “Pull requests” and “Issues”. Jarvis checks the signature on every delivery and only`
- L388 — product-facing: `0 turns it off. At most 50 links per check, each at most every 5 minutes; Jarvis waits when GitHub rate-limits.{" "}`

### `components/navigation/AppShell.tsx`

- L246 — product-facing: `aria-label="Jarvis home"`
- L250 — product-facing: `<span className="hidden xl:inline">Jarvis</span>`
- L263 — product-facing: `aria-label="Ask Jarvis"`

### `components/navigation/CommandDock.tsx`

- L448 — product-facing: `aria-label="Jarvis commands: tap for the command palette, hold for the action map (Ctrl+.)"`

### `components/navigation/Sidebar.tsx`

- L212 — product-facing: `<Link href="/home" aria-label="Jarvis home" className="flex min-h-11 flex-1 items-center gap-2 px-1.5 text-[0.9375rem] font-bold">`
- L214 — product-facing: `<span>Jarvis</span>`

### `components/onboarding/OnboardingWizard.tsx`

- L48 — product-facing: `<p className="text-sm font-medium text-accent">Jarvis setup</p>`
- L49 — product-facing: `<h1 className="text-3xl font-semibold tracking-tight">Claim this Jarvis</h1>`
- L153 — product-facing: `<p className="mb-2 text-sm font-medium text-accent">Jarvis setup</p>`
- L244 — product-facing: `Jarvis is your command center for <strong>Hermes</strong> and the systems around it. It answers one question:{" "}`

### `components/search/SearchDialog.tsx`

- L180 — product-facing: `return { areas, items, agents: [{ id: "jarvis", label: "Jarvis" }, ...modes.map((m) => ({ id: m, label: m }))], assignees, tags };`
- L682 — product-facing: `aria-label="Search Jarvis"`

### `components/skylight/model.ts`

- L26 — product-facing: `// Skylight's own flag only: a Family/group-assigned chore that Jarvis lists as up for grabs still 422s with category_id.`
- L31 — product-facing: `/** Move a one-off chore to \`day\` (recurring occurrences can't be moved from Jarvis). */`

### `components/smart/AnswerBatch.tsx`

- L135 — product-facing: `{q.proposed && !draft.edited?.includes(q.id) && draft.values[q.id] ? <p className="text-xs text-ai">Proposed by Jarvis · editable</p> : null}`

### `components/smart/SmartSurface.tsx`

- L257 — product-facing: `<span className="sv-tag">{smartLabel(spec.elements[spec.root]?.type) ?? "Jarvis"}</span>`
- L258 — product-facing: `<span className="sv-label">{stageable ? "Proposed changes" : "Jarvis view"}</span>`
- L345 — product-facing: `description="These changes write to your Jarvis items. You can Undo after applying."`
- L367 — product-facing: `description="These are written to the household calendar in Home Assistant and read back. Jarvis can't remove them later; delete them in the calendar if you change your mind."`

### `components/smart/WorkflowSurface.tsx`

- L75 — product-facing: `Built from Jarvis data {new Date(q.data.builtAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}. Nothing`

### `components/smart/workflow-components.tsx`

- L669 — product-facing: `<p className="min-w-0 flex-1 text-xs text-muted">{open ? "Merging happens on GitHub. Jarvis never merges." : "Read from GitHub just now."}</p>`

### `components/ui/index.ts`

- L2 — product-facing: `* Jarvis UI library — the ONE import surface for UI (\`import { … } from "@/components/ui"\`).`

### `components/ui/kit.test.tsx`

- L138 — product-facing: `expect(screen.getByRole("button", { name: "Jarvis commands" }).getAttribute("aria-expanded")).toBe("true");`

### `components/ui/kit.tsx`

- L334 — product-facing: `export const AGENT_NAMES: Record<Agent, string> = { cos: "Chief of staff", mom: "Mom", dev: "Dev", lab: "Lab", jar: "Jarvis" };`
- L810 — product-facing: `label = "Jarvis commands",`

### `components/ui/legacy.tsx`

- L209 — product-facing: `{label || (source === "jarvis" ? "Jarvis" : SOURCE_LABELS[source])}`

### `components/work/AdoptDialog.tsx`

- L18 — product-facing: `* Adopt an existing Hermes chat (one Jarvis didn't start — e.g. from the Hermes web UI) into`
- L64 — product-facing: `description={\`Jarvis will track it on ${current ?? "the default agent"} and file it under ${item.title}. Nothing in the chat changes.\`}`
- L92 — product-facing: `description="Chats you started outside Jarvis on this agent. The Bot Chat inbox is never listed."`

### `components/work/AgentChip.tsx`

- L4 — product-facing: `* #180 "by @profile" chip: a change an agent token made on the owner's behalf (Jarvis MCP,`

### `components/work/CustomHtmlWidget.tsx`

- L8 — product-facing: `* sandbox="allow-scripts" (opaque origin: no cookies, storage or Jarvis APIs)`

### `components/work/ai/AiActions.tsx`

- L237 — product-facing: `<p className="text-xs text-muted">Fast model estimates the effort. Your calendars are read by Jarvis only and never sent to AI.</p>`

### `components/work/ai/AiSettingsView.tsx`

- L222 — product-facing: `["jarvisTask", "Jarvis to-dos"],`

### `components/workflows/RunOutputs.tsx`

- L393 — product-facing: `<p className="mt-1 text-xs text-muted">Jarvis suggests one from your notes; nothing is saved until you accept it.</p>`
- L474 — product-facing: `<p className="mt-1 text-xs text-muted">Save to Google Drive isn&apos;t available yet: Jarvis has no Drive connection.</p>`
- L514 — product-facing: `description="Jarvis only sees files it creates in your Drive."`

### `components/workflows/WorkflowBuilder.tsx`

- L261 — product-facing: `Layouts use the Jarvis UI catalog only. The run panel uses the default outline for this workflow{d.layout ? " plus its custom layout" : ""}.`

### `components/workflows/WorkflowsGallery.tsx`

- L25 — product-facing: `/** Area paths as the workflow definition names them ("Faith", "Work/Jarvis"). */`

### `integrations/hermes/client.ts`

- L55 — product-facing: `export const HERMES_BUSY_MESSAGE = "Hermes is busy right now (too many requests at once). Jarvis kept trying for a few seconds; try again in a moment.";`

### `integrations/hermes/service.ts`

- L312 — product-facing: `// --- Adopt an existing session (one Jarvis didn't create) ---`
- L336 — product-facing: `* Recent sessions on a profile that Jarvis doesn't track yet (no session_meta row): the`
- L354 — product-facing: `* Start tracking a Hermes session Jarvis didn't create, on the profile it lives on: one GET on`
- L365 — product-facing: `throw new HttpError(409, "profile_mismatch", "Jarvis already tracks that conversation on another agent.");`
- L720 — product-facing: `// id (built before Jarvis read \`prompt_id\`) may only answer when exactly one prompt is waiting.`

### `integrations/hermes/structured.ts`

- L62 — product-facing: `"This is an automated request from the Jarvis dashboard, not a person.",`

### `integrations/home-assistant/devices.ts`

- L184 — product-facing: `throw new HttpError(403, "not_allowlisted", "Jarvis isn't allowed to switch that light (Settings → Connections → Home Assistant).");`

### `integrations/paperclip/service.ts`

- L171 — product-facing: `/** Unlinking only removes Jarvis' relationship record — never closes or deletes Paperclip work. */`
- L206 — product-facing: `description: [r.description?.trim(), \`Originated from Jarvis conversation: ${backlink}\`].filter(Boolean).join("\n\n"),`

### `integrations/registry.ts`

- L88 — product-facing: `help: "Hermes API Server, reachable from the Jarvis container. Keep it on the internal Docker network.",`
- L103 — product-facing: `help: "Used for deep links to settings Jarvis does not manage.",`
- L112 — product-facing: `help: "Recorded on sessions created from Jarvis.",`
- L119 — product-facing: `tagline: "One canonical todo list: Google Tasks, a Home Assistant list, or Jarvis itself.",`
- L120 — product-facing: `uses: ["Overdue and due-soon actions on Home", "Complete and snooze from Jarvis"],`
- L132 — product-facing: `{ value: "jarvis", label: "Built into Jarvis" },`
- L141 — product-facing: `help: "Create a Web OAuth client in Google Cloud with redirect URI <your Jarvis URL>/api/integrations/todos/oauth/callback.",`
- L212 — product-facing: `{ value: "hermes", label: "Hermes owns Daily Compass (Jarvis asks Hermes for today's state)" },`
- L213 — product-facing: `{ value: "jarvis", label: "Stored in Jarvis (check-in is a Hermes conversation)" },`
- L233 — product-facing: `help: "How often Jarvis asks Hermes for today's check-in state.",`
- L242 — product-facing: `help: "Placeholders: {date}, {timezone}. Must be read-only; Jarvis appends a JSON answer contract.",`
- L251 — product-facing: `help: "Placeholders: {date}, {timezone}. Hermes must read the state back; Jarvis only reports done when the answer says completed.",`
- L298 — product-facing: `help: "entity_id: service, service — or domain.*: service for every entity in a domain. Defaults cover lights, switches, fans, climate, media, scenes, scripts, vacuums, covers (incl. garage), locks and alarm panels. Only services in the Jarvis policy can run; locks, alarm and opening a garage are high-risk (explicit confirm, rate-limited). Every control is confirmed and read back.",`
- L331 — product-facing: `label: "How Jarvis reads Skylight",`
- L338 — product-facing: `help: "Via Hermes: Jarvis sends Hermes a read-only structured request and caches the validated answer. Needs Hermes connected with its Skylight tools.",`
- L355 — product-facing: `help: "Placeholders: {from}, {to}, {timezone}. Jarvis appends a JSON answer contract; keep this read-only.",`
- L363 — product-facing: `help: "Use “Sign in to Skylight” below, or paste one from \`skycli auth login\`. Skylight rotates it on every refresh; Jarvis stores the new one automatically.",`
- L385 — product-facing: `help: "Your Skylight member(s), comma-separated ids. “Test connection” lists the frame's members to pick from. Blank: Jarvis matches your name, else shows everyone's until you pick.",`
- L418 — product-facing: `label: "Let Jarvis change Skylight",`
- L527 — product-facing: `help: "After asking Monarch to sync, Jarvis waits this long for fresh balances before reading what's there (and saying so).",`

### `integrations/skylight/adapter.ts`

- L19 — product-facing: `* - "hermes" (default): Skylight is Hermes-owned. Jarvis sends a structured,`
- L193 — product-facing: `/** The owner's member ids: configured, else a unique name match against the Jarvis owner. */`
- L570 — product-facing: `// Skylight's own flag (not Jarvis' group classification): only these completions may name who did it.`
- L654 — product-facing: `\`${err.message}. Check that the Hermes profile serving Jarvis has the jarvis-skylight-read skill installed and SKYLIGHT_USERNAME, SKYLIGHT_PASSWORD and SKYLIGHT_FRAME_ID set (docs/operations/skylight-reliability.md), or switch to “Directly” and sign in.\`,`

### `integrations/todos/adapter.ts`

- L35 — product-facing: `/** Source chip text: "Google Tasks · <list>", "Home Assistant · <list>", "Jarvis". */`
- L141 — product-facing: `sourceLabel: "Jarvis",`
- L249 — product-facing: `return runChecks([{ name: "Built-in list", run: async () => "Todos are stored in Jarvis" }]);`
- L299 — product-facing: `* Smart-UI undo: reopen a todo Jarvis completed (or "dropped"). Readback`
- L341 — product-facing: `* audited \`todos.drop\`, and on Jarvis-local todos prefix the note so the list shows why.`

### `integrations/todos/google.ts`

- L114 — external identity (retain remote name): `"Google did not return a refresh token. Remove Jarvis from your Google account's third-party access and try again.",`

### `lib/activity.ts`

- L26 — product-facing: `export const ACTOR_LABELS: Record<ActorKind, string> = { you: "You", agent: "Agent", github: "GitHub", system: "Jarvis" };`
- L73 — product-facing: `if (actor === "system" || actor === "jarvis" || actor === "auto") return { kind: "system", name: "Jarvis" };`

### `lib/agent-runs.ts`

- L22 — product-facing: `/** Jarvis \`runs.status\` (lib/hermes.ts RunPhase) → live state. */`
- L209 — product-facing: `/** A turn is in flight in one of the task's chats right now (a run Jarvis started there), or an AI action on it: since when. */`

### `lib/agents.ts`

- L79 — product-facing: `missing_key: "This profile's key isn't in the Jarvis secrets file yet, so it is sent as a hint to the default profile",`

### `lib/agui/reducer.ts`

- L3 — product-facing: `* server/agui/hermes.ts → the Jarvis \`RunEvent\`s the chat run reducer`

### `lib/ai.ts`

- L56 — product-facing: `description: "Estimates the effort; Jarvis finds free slots in your calendars (calendars never go to AI).",`

### `lib/assistant.ts`

- L7 — product-facing: `claude: { label: "Claude", description: "Direct to Claude: fast answers, no tools. Uses Jarvis context you attach." },`

### `lib/away.ts`

- L482 — product-facing: `"You are running unattended on a schedule (the owner is away). Do not make changes yourself with tools: Jarvis refuses direct write tools from this profile while the run is active.",`
- L486 — product-facing: `? \`This area allows Jarvis to apply low-risk proposals (${LOW_RISK_INTENTS.join(", ")}) automatically with undo; everything else goes to the owner as a decision.\``

### `lib/brief.ts`

- L259 — product-facing: `/** How the agent stands on a request, from Jarvis' own run records (lib/agent-runs.ts RunLive). */`
- L360 — product-facing: `/** the area whose agent takes "Improve" requests (null: Jarvis picks, see server/brief/improve.ts) */`
- L427 — product-facing: `/** what the model was given, by label ("Todos", "Calendar", "3 things you taught Jarvis") */`
- L430 — product-facing: `/** today's calendar, for the day arc and the "right now" line (Jarvis' own data, whatever the model placed) */`

### `lib/capture-triage.ts`

- L219 — product-facing: `return \`Keep “${a.title}” as a Jarvis to-do\`;`
- L231 — product-facing: `return \`filed “${a.title}” as a Jarvis to-do\`;`
- L286 — product-facing: `if (!choices.some((c) => c.action?.type === "jarvis_task")) push("Just keep it as a Jarvis to-do", { type: "jarvis_task", title: name, nextAction: name });`
- L323 — product-facing: `/** a suggestion Jarvis can do once the owner confirms ("Do it") */`

### `lib/catch-up.ts`

- L2 — product-facing: `* "Catch me up" prompt for an area's coordinator chat (Work from Jarvis batch 2).`

### `lib/chat-execution.ts`

- L12 — product-facing: `* - \`href\` is an INTERNAL Jarvis path only (/chat/<id>, /areas?item=<id>); host transcript`
- L19 — product-facing: `| "fork" // Jarvis fork of this chat (session_meta.forked_from_session_id)`
- L20 — product-facing: `| "jarvis_run" // Jarvis-started run recorded against a work item`

### `lib/chat-files.ts`

- L126 — product-facing: `/** Hidden marker in the "Context from Jarvis" section so the bubble can show its attachments. */`

### `lib/chat/actions.ts`

- L6 — product-facing: `* Jarvis MCP tools appear as \`mcp__jarvis__jarvis_<tool>\` (any \`mcp__<server>__\` prefix is`
- L10 — product-facing: `* Links are INTERNAL Jarvis paths only (/areas?item=<id>) or the https URL the agent linked.`

### `lib/chat/display.test.ts`

- L31 — product-facing: `it("separates what was typed from what Jarvis attached", () => {`
- L32 — compatibility (retain delimiter): `expect(splitAttachedContext("Look at this\n\n---\nContext from Jarvis:\n- Storefront [item:wi_1]")).toEqual({`

### `lib/chat/display.ts`

- L33 — compatibility (retain delimiter): `export const ATTACHED_CONTEXT_MARK = "\n\n---\nContext from Jarvis:";`

### `lib/client/api.ts`

- L34 — product-facing: `throw new ApiError(0, typeof navigator !== "undefined" && !navigator.onLine ? "You're offline" : "Couldn't reach Jarvis", "network");`

### `lib/client/run-state.ts`

- L40 — product-facing: `/** Why the run shows "Queued": Hermes' own queue, or Jarvis waiting for a free Hermes connection. */`

### `lib/client/wrapper.ts`

- L4 — product-facing: `* "Is this page running inside the Jarvis Android app (a Trusted Web Activity)?"`

### `lib/composer-target.ts`

- L2 — product-facing: `* The global "Ask Jarvis" composer (⌘K palette, desktop dock, phone orb) is area-contextual:`
- L34 — product-facing: `/** who answers: the routed profile, else "Jarvis" */`
- L45 — product-facing: `export const JARVIS_TARGET: ComposerTarget = { agent: "Jarvis", routed: false, node: null, areaId: null, context: undefined };`
- L50 — product-facing: `* \`useJarvis\` = the owner switched the chip back to plain Jarvis.`
- L56 — product-facing: `agent: routed ? agent!.profile! : "Jarvis",`
- L64 — product-facing: `/** "Ask momentumchief · Momentum bets" / "Ask Jarvis". */`
- L66 — product-facing: `return t.node ? \`Ask ${t.agent} · ${t.node.title}\` : "Ask Jarvis";`

### `lib/contracts.ts`

- L9 — product-facing: `/** Everything that can put a card on Home: the adapters plus Jarvis' own per-person Work hub. */`
- L176 — product-facing: `/** Upstream \`up_for_grabs\` flag (group-assigned chores can read as up for grabs in Jarvis without it). */`

### `lib/coordinator/control.ts`

- L3 — product-facing: `* delegate_task children only to the PARENT agent (\`delegate_task action=steer|stop\`), so Jarvis`

### `lib/cw-runs.ts`

- L66 — product-facing: `* (found, made, blocked, handed off) as \`moment\` on a \`progress\` event; Jarvis writes the rest from what happens`

### `lib/feedback.ts`

- L8 — product-facing: `* - Ratings are the rater's own (user-scoped); nothing leaves Jarvis until the`
- L225 — product-facing: `"Use read tools (e.g. jarvis_search) to find existing Jarvis items for each cluster. " +`

### `lib/github.ts`

- L92 — product-facing: `return \`https://github.com/settings/personal-access-tokens/new?name=Jarvis%20read-only&target_name=${encodeURIComponent(ownerName || "<owner>")}&expires_in=365&pull_requests=read&issues=read\`;`
- L106 — product-facing: `/** "Jarvis (<host>)", trimmed to 34 characters */`
- L184 — product-facing: `installed: "Installed on GitHub. Jarvis is reading the installations…",`
- L186 — external identity (retain remote name): `forbidden: "Only an admin signed in to Jarvis can finish creating the GitHub App.",`

### `lib/ha-policy.ts`

- L2 — product-facing: `* Home Assistant control policy (owner decision 2026-11-07: "Jarvis should be`
- L167 — product-facing: `/** Switched off (as opposed to unavailable/unknown, where Jarvis can't tell). */`

### `lib/hermes.ts`

- L48 — product-facing: `/** "connections": Jarvis is waiting for a free Hermes connection (the run itself was accepted). */ reason?: "connections";`
- L95 — product-facing: `/** Jarvis-side lineage when a fork was approximated ("fork from here") */`
- L118 — product-facing: `/** Hermes no longer has this run: what is shown is Jarvis's own record, so nothing about how it ended is known. */`
- L120 — product-facing: `/** Secrets Jarvis removed from this message before it reached AI (hints like "password: …", never the value). */`

### `lib/item-tags.ts`

- L99 — product-facing: `if (!PROFILE_NAME_RE.test(id) || !ctx.agents.includes(id)) return { ok: false, error: "That agent isn't set up in Jarvis" };`

### `lib/jarvis-ui/catalog.ts`

- L277 — product-facing: `/** Static (model estimate, labelled as such) or \`{metric}\` (Jarvis-computed, live). */`
- L335 — product-facing: `BarChart: "{metric,label?} bars from a Jarvis series only",`
- L348 — product-facing: `Gauge: "{metric} live Jarvis number, or {label, value, max, unit?, note?} as your estimate",`
- L349 — product-facing: `Sparkline: "{metric, label?} trend from a Jarvis series",`
- L351 — product-facing: `WeekPlan: "{weekOf: Monday, days?: 5|7, blocks:[{ref, day: YYYY-MM-DD|null, start?: HH:MM, minutes}]} Jarvis adds calendar events",`

### `lib/jarvis-ui/labels.ts`

- L14 — product-facing: `Stack: "Jarvis",`

### `lib/jarvis-ui/parser.ts`

- L63 — product-facing: `return segs.some((s) => s.kind === "block") ? \`${textOnly}\n\n_Structured reply (open in Jarvis)_\`.trim() : textOnly;`

### `lib/jarvis-ui/validator.ts`

- L117 — product-facing: `/** The hydration ref for a week plan's fixed calendar events (synthesized by Jarvis; never written by the model). */`

### `lib/people.ts`

- L9 — product-facing: `/** set up this Jarvis; can't be removed */`

### `lib/portfolio-import.ts`

- L4 — product-facing: `* Jarvis. This pure planner maps the board's JSON onto the Areas tree:`
- L72 — product-facing: `jarvis: ["General Dev", "Jarvis"],`
- L110 — product-facing: `/** links the board had that Jarvis can't store (file paths, non-https) */`
- L291 — product-facing: `reason: newLinks.length || newTags.length ? undefined : "already in Jarvis",`

### `lib/portfolio-view.ts`

- L21 — product-facing: `/** "General Dev" for General Dev / Jarvis; "" for an area row */`

### `lib/references.ts`

- L2 — product-facing: `* Composer references (phase 4): \`@\` for everything Jarvis knows (areas, work`

### `lib/resume.ts`

- L9 — product-facing: `* Reads only Jarvis's own data (conversation index, work items, agent runs): never Hermes live.`

### `lib/session-children.ts`

- L5 — product-facing: `* (webui-run delegations) a derived title starting "Subagent:". Jarvis forks also carry a parent`

### `lib/task-source.ts`

- L77 — product-facing: `* Auto-match the Jarvis user to Skylight members by first name (or the email's`
- L138 — product-facing: `jarvis: "Jarvis",`

### `lib/tool-presentation.test.ts`

- L4 — product-facing: `it("unwraps Jarvis batches without displaying JSON", () => {`

### `lib/tool-presentation.ts`

- L28 — product-facing: `label = "Jarvis request";`
- L57 — product-facing: `: "Jarvis request";`

### `lib/work.ts`

- L733 — product-facing: `.refine((c) => !c.href || safeHref(c.href) !== null, { path: ["href"], message: "Links must be http(s) or a Jarvis path" });`
- L824 — product-facing: `* storage, no Jarvis APIs (connect-src falls back to 'none').`

### `lib/workflows/definition.ts`

- L293 — product-facing: `if (!r.ok) issues.push({ path, code: "layout_invalid", message: "Layout must use the Jarvis UI catalog only" });`

### `public/sw.js`

- L251 — product-facing: `data = { title: "Jarvis", body: event.data ? event.data.text() : "" };`
- L253 — product-facing: `const title = data.title || "Jarvis";`

### `server/agent-access/ha-proposals.ts`

- L25 — product-facing: `throw new HttpError(403, "not_allowlisted", "That device action isn't allowed in Jarvis");`

### `server/agent-access/mcp.ts`

- L73 — product-facing: `"Jarvis work items for the owner. Writes are attributed to you, logged and undoable. You can't settle, archive, move, split, merge or delete — propose those with jarvis_request_change. AI-excluded subtrees are hidden. Never include credentials, tokens or full account numbers.",`
- L110 — product-facing: `// run's proposals block, where Jarvis applies Propose-only / Act-on-low-risk (#230).`
- L116 — product-facing: `"A scheduled run for this agent is active, so direct writes are off. List the change in the jarvis-proposals block instead; Jarvis applies the area's autonomy policy (decisions in Needs you, low-risk changes only where allowed).",`

### `server/agent-access/tools.ts`

- L52 — product-facing: `/** A transcript path on the agent's host: shown as copyable text only (Jarvis never opens it). */`
- L370 — product-facing: `description: "Link a GitHub PR or issue URL, or an https URL (e.g. an artifacts board), to an item. Jarvis doesn't fetch the URL.",`
- L478 — product-facing: `"File one of this agent's own Hermes conversations (by session id, on this token's profile) under an item or area so it shows in Jarvis. Hidden, Bot Chat and sub-agent sessions are refused.",`

### `server/agents/composer.ts`

- L78 — product-facing: `\`Asked from Jarvis ${node.kind}: ${node.path.join(" › ")}\`,`

### `server/agui/hermes.ts`

- L4 — product-facing: `* Input: Jarvis' normalized Hermes run events (\`RunEvent\`, from`

### `server/ai/context.ts`

- L14 — product-facing: `export const TRUNCATED = "\n[…context truncated by Jarvis]";`

### `server/ai/prompts.ts`

- L60 — product-facing: `summary: "≤200: what Jarvis would do, e.g. Add “Milk” to Groceries on Skylight",`
- L83 — product-facing: `"You are working for Nick inside Jarvis, in the background. Nobody is watching live.",`
- L123 — product-facing: `\`Also decide what Jarvis could DO to resolve it (the \"action\" field; Jarvis itself performs it after checking it is low-risk — you never act). Today is ${v.today ?? "unknown"}.\`,`
- L126 — product-facing: `'- skylight_event_create: an appointment/event for the family calendar. Only fill event.date/time when the capture states them (resolve words like "tomorrow 3pm" against today). NEVER guess a date or time: if missing, list them in missing[], ask one short question, and offer 2–3 choices (e.g. add it as a to-do on a Skylight to_do list, or keep it as a Jarvis to-do).',`
- L128 — product-facing: `"- jarvis_task: work for Nick that belongs in Jarvis, not on the family Skylight.",`
- L129 — product-facing: `"- ha_device (lights, garage, locks, alarm…), message (email/texts to people), purchase, finance, delete: Jarvis only suggests these — still classify them.",`

### `server/ai/rules.ts`

- L173 — product-facing: `[/^(?:jdv|jcap|jva)_/, "Jarvis token"],`

### `server/ai/runner.ts`

- L728 — product-facing: `body: "Open Today to see what Jarvis prepared.",`

### `server/ai/schedule.ts`

- L2 — product-facing: `* "Suggest a time" (pure, spec §7.3): Jarvis computes free slots from the`

### `server/assistant/index.ts`

- L121 — product-facing: `/** \`format: "agui"\` streams AG-UI events (Hermes runs only; Claude-direct keeps Jarvis events, which the client also reads). */`

### `server/assistant/local.ts`

- L20 — product-facing: `* No tools: Claude can't act here, only answer (with any Jarvis context the`
- L35 — product-facing: `const SYSTEM = \`You are Jarvis, a household assistant inside a private family dashboard. Answer clearly and briefly; use short paragraphs or lists when they help.`
- L36 — product-facing: `You can't take actions, see devices or read accounts yourself. When the message includes a "Context from Jarvis" section, treat it as current facts from the household's own systems and say how fresh it is when that matters. If something isn't in the context, say you don't know rather than guessing.\`;`
- L379 — compatibility (retain delimiter): `inputPreview: r.input.split("\n\n---\nContext from Jarvis:")[0]!.slice(0, 140),`
- L409 — product-facing: `return { runId, sessionId: row.sessionId, status: "interrupted", error: "Jarvis restarted while Claude was answering." };`

### `server/auth/index.ts`

- L96 — product-facing: `if (isClaimed()) throw new AuthError("already_claimed", "This Jarvis instance is already set up.");`

### `server/brief/assist.ts`

- L29 — product-facing: `* The sparkle on a row of the brief: "look into this one". Jarvis files the task`
- L40 — product-facing: `* What comes back is read from Jarvis' own records: the run's state, the next`
- L88 — product-facing: `/** What this person asked an agent to look into lately, by row. Reads Jarvis' own records only. */`
- L113 — product-facing: `// The next action on an item Jarvis made for this is the agent's (or the person's own edit of it).`
- L144 — product-facing: `* Areas are shared with the model, and kept once asked (what was asked then is read from Jarvis'`
- L176 — product-facing: `\`It is tracked as the Jarvis item "${item.title}" (id ${item.id}). If you have Jarvis tools, set that item's next action to the first step and add a note on it titled "Next steps" with one step per line.\`,`

### `server/brief/compose.ts`

- L24 — product-facing: `* - \`rulesBrief\`: the brief Jarvis builds without a model, straight from the`
- L27 — product-facing: `*   model didn't get are dropped, titles always come from Jarvis' own data,`

### `server/brief/context.ts`

- L415 — product-facing: `"things you may pick: ref | bucket | where | title | due | why Jarvis ranks it there",`

### `server/brief/deck.ts`

- L19 — product-facing: `* (On the calendar, Low priority). Built on read from Jarvis' own data. No model`

### `server/brief/improve.ts`

- L55 — product-facing: `* last time, else an area called "Jarvis", else the portfolio coordinator's`
- L116 — product-facing: `/** Requests whose item is still open, newest first. Reads Jarvis' own records only. */`
- L172 — product-facing: `"I want to change how Jarvis works for me. I am asking from my daily brief (the Home screen).",`
- L174 — product-facing: `\`This is tracked as the Jarvis item "${item.title}" (id ${item.id}). Work out what it takes, ask me whenever a decision is mine to make, and keep that item up to date as you go. This is a request to change the app, not to rewrite today's brief.\`,`
- L193 — product-facing: `/** Jarvis made \`item\` for this request (Undo and a failed start archive it again) */`
- L239 — product-facing: `? [\`Jarvis area: ${where.area.title}.\`, modeHint ? \`Agent mode: ${modeHint}.\` : "", s.instructions ?? ""].filter(Boolean).join(" ")`

### `server/brief/index.ts`

- L66 — product-facing: `if (!isConfigured("hermes")) return { available: false, reason: "Connect Hermes so Jarvis can write your brief." };`

### `server/brief/journal.ts`

- L7 — product-facing: `* Check-in journal: Jarvis only ever held today's Daily Compass answer (one`

### `server/brief/prompt.ts`

- L54 — product-facing: `"You write one person's daily brief inside Jarvis, their private dashboard. It opens their day: what matters most, what to do first, and what you have noticed about them lately. You are the one who knows them well and says so plainly. Nobody is watching live.",`
- L57 — product-facing: `"1. Judgment about the day. Jarvis already ranks by due date; you decide what is most IMPORTANT to this person today, from what they said in their check-ins, what you know about them, their feedback on earlier briefs, how earlier picks turned out and whether they did the small things you suggested. Something a check-in named for today outranks a due date unless something is truly urgent. Say when the urgent thing and the important thing differ, and which to do first.",`
- L63 — product-facing: `"- Refer to tasks ONLY by the refs in the pick list. Jarvis shows each task's real title, due date and place, so never restate, invent or guess titles, times, amounts or counts for them. No ref, no mention.",`
- L69 — product-facing: `\` steps: on a callout, idea or nudge you may give up to ${BRIEF_LIMITS.blockSteps} small things to do, each doable in minutes. Plain text; Jarvis does not create tasks from them.\`,`
- L71 — product-facing: `"  Widgets Jarvis fills with its own data: schedule, momentum, household, dates, compass, training. Include a widget only when it helps today; you may add one line of text to it. Never state its numbers yourself.",`

### `server/brief/store.ts`

- L27 — product-facing: `* feedback and the notes that make up "what Jarvis knows about you". Everything`
- L326 — product-facing: `// ---------------------------------------------------------------- notes ("what Jarvis knows about you")`

### `server/capture/triage-views.ts`

- L108 — product-facing: `summary: "Jarvis couldn't triage this capture.",`
- L130 — product-facing: `/** Whether a suggestion row has a "Do it" (a low-risk action Jarvis can run once the owner confirms). */`

### `server/capture/triage.ts`

- L34 — product-facing: `* \`skylight.write\`, 12 writes/min), Jarvis items via createItem/updateItem (work_ops = Activity`
- L92 — product-facing: `risky: "Jarvis only suggests this; do it yourself if it's right.",`
- L226 — product-facing: `why: \`From your capture “${entry.title.slice(0, 200)}”. Jarvis won't guess dates or times.\`.slice(0, 600),`
- L318 — product-facing: `const summary = \`Filed “${title}” as a Jarvis to-do.\`;`
- L333 — product-facing: `\`You captured “${entry.title}”. If that's wrong, Undo it here or correct it in Skylight. Jarvis never settles: settle it when you're happy.\`,`
- L437 — product-facing: `/** "Do it" on a suggestion that Jarvis could do (owner's explicit confirm; risky types never). */`
- L450 — product-facing: `if (out.kind !== "auto") throw new HttpError(409, "not_applicable", "Jarvis can't do this one for you");`

### `server/chat/links.ts`

- L66 — product-facing: `/** Artifact slugs → readable title ("jarvis-chat-context-20261030" → "Jarvis chat context · 2026-10-30"). */`

### `server/chat/subagent-log.ts`

- L13 — product-facing: `* (the default profile: \`<HERMES_HOME>/cache/delegation/live/...\`). The Jarvis container sees only those`

### `server/context.ts`

- L14 — product-facing: `* "Ask Hermes about …": a plain-text snapshot of what Jarvis currently knows`
- L146 — product-facing: `const lines = ["Jarvis overview:"];`

### `server/db/schema.ts`

- L206 — product-facing: `/** "android-app" when subscribed inside the Jarvis Android app (TWA); skipped when that phone gets FCM. */`
- L381 — product-facing: `/** Built-in todo store — only used when "Jarvis" is the canonical todo provider. */`
- L490 — product-facing: `* lives on the item; state is read from Jarvis' own run records, never stored here.`
- L936 — product-facing: `* shared runs table. Hermes keeps its own transcripts; these are Jarvis's.`
- L1285 — product-facing: `/** the Jarvis person whose Work inbox receives this token's assigned issues */`
- L1933 — product-facing: `* Never applied by Jarvis; Start and Send are the owner's tap. Evidence is the owner's own tasks the reason comes`
- L2068 — product-facing: `/** where the sub-agent transcript lives on the agent's host (shown as copyable text, never read by Jarvis) */`

### `server/drive/google-drive.ts`

- L14 — product-facing: `* - Scope: \`drive.file\` ONLY (files Jarvis creates; no access to the rest of Drive).`
- L77 — product-facing: `if (!driveEnabled()) throw new HttpError(404, "drive_disabled", "Save to Google Drive isn't turned on for this Jarvis");`
- L155 — external identity (retain remote name): `"Google did not return a refresh token. Remove Jarvis from your Google account's third-party access and try again.",`

### `server/home-tuning.ts`

- L388 — product-facing: `\`Jarvis Home ranking (version 1): Now shows up to ${budget.now}, Today up to ${budget.today}, Upcoming preview ${budget.upcoming}; the rest is a counted backlog.\`,`

### `server/people.ts`

- L131 — product-facing: `throw new HttpError(409, "last_admin", "Jarvis needs at least one admin.");`
- L136 — product-facing: `throw new HttpError(409, "owner", "The person who set up Jarvis stays an active admin.");`
- L172 — product-facing: `if (id === getOwner()?.id) throw new HttpError(409, "owner", "The person who set up Jarvis can't be removed. Disable them instead.");`
- L175 — product-facing: `if (user.role === "admin" && adminsLeft(id) === 0) throw new HttpError(409, "last_admin", "Jarvis needs at least one admin.");`

### `server/ranking/assists.ts`

- L103 — product-facing: `"Help me triage my overdue tasks. This is read-only planning: don’t complete, reschedule or delete anything. For each one, suggest do it this week, reschedule (with a date) or drop, and I’ll make the changes in Jarvis myself.",`
- L157 — product-facing: `chat: planChat(input, m.title, occ, days, \`Saved date in Jarvis: ${m.title}, ${occ}${m.yearly ? " (yearly)" : ""}.\`),`

### `server/search-index.ts`

- L115 — product-facing: `/** Session ids among \`ids\` archived in session_meta (where Jarvis records archive for Hermes and Claude-direct chats). */`

### `server/smart/calendar.ts`

- L52 — product-facing: `event: { summary, allDay: false, startsAt: start.toISOString(), endsAt: end.toISOString(), description: "Planned in Jarvis" },`
- L63 — product-facing: `description: "Planned in Jarvis",`

### `server/smart/context.ts`

- L40 — product-facing: `const head = \`Overdue todos Jarvis can see (${rows.length} total${rows.length > list.length ? \`, first ${list.length}\` : ""}, most recently due first). Columns: ref | title | due | source\`;`

### `server/smart/prompt.ts`

- L33 — product-facing: `BarChart: "{metric,label?} Jarvis series only",`
- L42 — product-facing: `"metric:ai_spend_today|ai_spend_7d|items_done_14d|overdue_count: Jarvis numbers, never yours.",`

### `server/smart/workflows.ts`

- L227 — product-facing: `\`Morning brief for ${today}. Use ApprovalChips for the rows, Gauge/Sparkline with these metric refs (Jarvis fills in the numbers): ${metrics.join(", ")}.\`,`
- L242 — product-facing: `\`Week plan: WeekPlan weekOf ${weekOf} (Mon–Fri, today ${today}). Place blocks on days ≥ today, 07:00–21:00, around these fixed events (Jarvis shows them; don't add them as blocks):\`,`

### `server/sources.ts`

- L223 — product-facing: `* Today's Daily Compass focus as far as Jarvis honestly knows it. Undefined for`
- L286 — product-facing: `// Work is Jarvis' own per-person data: computed here (local, no fetch) for people with work.use.`

### `server/work/agent-runs.ts`

- L119 — product-facing: `// Jarvis's own mirror of a sub-agent (server/work/delegated-runs.ts) is already shown as that sub-agent.`

### `server/work/answer-delivery.ts`

- L102 — product-facing: `// Jarvis's record of the turn can lag (no chat open, worker off): ask Hermes before steering or waiting.`

### `server/work/chat-context.ts`

- L24 — product-facing: `\`You are the ${areaTitle} coordinator in Jarvis: you coordinate work, you don't just chat. For each request:\`,`
- L27 — product-facing: `? \`2. Dispatch: run independent pieces in parallel with delegate_task. Register every sub-agent on the item it serves with jarvis_run_start (itemId; delegationId = <delegation id>:<subagent id> — one per child, never the bare batch id; hermesSessionId = ${sessionId} unless you know the child's) and update it with jarvis_run_update when it finishes or fails. Jarvis also lists sub-agents it sees in this conversation on ${scopeId}.\``
- L31 — product-facing: `? "4. Record: create or update Jarvis items for the work, link PRs and boards (jarvis_link), and raise a decision (jarvis_raise_decision) for anything only the owner can choose. Never settle, archive or move: use jarvis_request_change."`
- L36 — product-facing: `'Decisions and runs live in Jarvis (Needs you / Running tabs), not in your replies: don\'t re-list open decisions or end replies with a status footer. Raise each owner question once with jarvis_raise_decision and refer to it by its D-n id (e.g. "waiting on D-48"); supersede your own instead of re-asking. Report progress on a registered run with jarvis_run_event (R-n) rather than a chat message; background completion notices are folded into the run, so only write when something changed for the owner.',`
- L47 — product-facing: `* and whether this Hermes profile can use Jarvis item tools. Without it, a chat routed to its area's own`
- L91 — product-facing: `\`This conversation is filed in Jarvis under: ${path.join(" › ")} (${scope.kind} id ${scope.id}). Jarvis conversation id: ${sessionId}.\`,`
- L93 — product-facing: `? "You can read more and act with the Jarvis tools (jarvis_get_item, jarvis_tree, jarvis_update_item …). Settling, archiving and moving are owner-only: use jarvis_request_change."`
- L94 — product-facing: `: \`You have no Jarvis item tools in this conversation${snapshot ? ": use the snapshot below to answer" : ""}. To change items, list the exact changes (item id + change) for the owner to apply; never claim you changed anything. Settling is always the owner's call.\`,`

### `server/work/cw-push.ts`

- L50 — product-facing: `body: parseRisk(d.riskJson).includes("credential") ? "Open Jarvis to see the question." : safeText(d.question, "Open Jarvis to see the question."),`

### `server/work/decision-store.ts`

- L397 — product-facing: `throw new HttpError(409, "confirm_in_app", \`${decisionRef(r.seq)} needs a confirmed answer in Jarvis\`);`

### `server/work/delegated-runs.ts`

- L11 — product-facing: `/** Prefix of agent_runs.delegation_id rows Jarvis created itself from a conversation's sub-agents. */`
- L59 — product-facing: `* Same task title. Hermes' session list truncates long child titles with "…" ("Subagent: Resume owning Jarvis`

### `server/work/github-app-rules.ts`

- L26 — product-facing: `/** "Jarvis (jarvis.example.com)", trimmed to GitHub's 34-character limit. */`
- L34 — product-facing: `const name = \`Jarvis (${host})\`;`
- L42 — product-facing: `description: "Read-only access for the Jarvis Work hub: pull request, issue and CI state. Jarvis never writes to GitHub.",`

### `server/work/github-app.ts`

- L42 — product-facing: `* /api/github/app/callback, and Jarvis exchanges the code for the App's`

### `server/work/github-rules.ts`

- L39 — product-facing: `export const WRITE_WARNING = "This token can write — Jarvis only needs read. Prefer a fine-grained read-only token.";`

### `server/work/github.ts`

- L145 — product-facing: `throw new HttpError(503, "github_rate_limited", "GitHub rate limit reached; Jarvis will wait before reading again");`

### `server/work/home-rules.ts`

- L19 — product-facing: `/** #229: the item's recorded creator (work_items.created_via), like Jarvis-local todos, so /todos' AI segment sees agent-created work. */`

### `server/work/resume-runs.ts`

- L111 — product-facing: `if (detectSensitivity(input) === "credentials") input = resumePrompt(listed.map((r) => ({ ref: r.ref, title: "see Jarvis" })));`
- L155 — product-facing: `// An agent's own session (made outside Jarvis) is recorded on the run's profile first, so the run goes to`

### `server/work/resume.ts`

- L20 — product-facing: `/** Everything in flight + recent conversations, from Jarvis's own data only. */`

### `server/work/session-end.ts`

- L149 — product-facing: `// A session Jarvis tracks keeps its recorded profile; an agent's own session lives on the run's profile.`

### `server/work/store.ts`

- L1286 — product-facing: `// Hermes is slow or down: never skip the access check. Jarvis' own record`

### `server/work/task-runs.ts`

- L58 — product-facing: `/** The Hermes run that is in flight in this conversation, if any (Jarvis' own record of runs it started). */`
- L128 — product-facing: `\`Jarvis task: ${item.title} (item ${item.id}), run ${ref}. This conversation is the task's chat: do the work here.\`,`

### `server/work/tasks.ts`

- L20 — product-facing: `* queue all read. From Jarvis's own records only (items, registered runs and their events, open decisions, pull`

### `server/workflows/outputs.ts`

- L53 — product-facing: `\`End-of-session summary for the Jarvis workflow "${def.name}".\`,`

### `server/workflows/store.ts`

- L42 — product-facing: `/** Area paths ("Faith", "Work/Jarvis") → item id, plus the areas AI can't use (aiPolicy=excluded). */`

### `server/workflows/test-turn.ts`

- L33 — product-facing: `"SANDBOX TEST TURN for a Jarvis workflow draft. Nothing you answer is saved.",`

## Intentional old-name hits retained

- All lowercase `jarvis` identifiers/namespaces and files beneath `lib/jarvis-ui/` remain protocol/catalog compatibility surfaces.
- Android `com.nickbolles.jarvis` packages, `Theme.Jarvis` style IDs, app-link/certificate/host references, and Java/Kotlin class names remain stable identities.
- Existing historical fixture/record text and tests that assert those records remain unchanged unless they assert an edited live product label.
- The outgoing and parsed `Context from Jarvis:` marker remains byte-for-byte stable; parsers were not broadened because compatibility is preserved by retaining the marker.
- Hermès/Hermes runtime/provider names and the `Chief of Staff` role remain unchanged.
