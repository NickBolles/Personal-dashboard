# Jarvis design system v1 — Command Center + Tide/Lagoon

**Status:** canonical (owner decision 2026-10-28). Supersedes the visuals of `/opt/data/worktrees/jarvis-design-pass/` (its repo mapping and PR slicing are reused).
**Sources:** `jarvis-design.html` (base system: principles, tokens, components, shell, 22 pages, states, flows, redlines, keyboard, decisions) + `jarvis-sea.html` (theme: owner's pick **Tide with Lagoon text**).
**Reference page:** https://artifacts.ai.nickbolles.com/jarvis-design-v1-20261028/ (design.html with this theme applied + phone orb nav).
**Tokens:** `tokens.css` (this folder) · repo: `app/globals.css` (PR1) · components: `components/ui/*` (PR2) · live kit: `/dev/kit` (owner-only).

## 1. Rules (non-negotiable)

1. **One primary per view.** Exactly one `Button variant="primary"` (solid `--acb`) visible per page/pane/dialog; everything else secondary/ghost.
2. **Blue = you act. Teal = an agent did/proposes this.** `--ac/--acb` for actions, focus, selection, checks. `--ai` (Lagoon) only for agent text, agent pills, live dot, AI spend ring, "From agents" count, agent progress, staged/proposed surfaces.
3. **Proposed = dashed teal.** Anything an agent proposes but hasn't been applied: 1px dashed `--aib` outline + `--ais` fill (`Pill tone="prop"`, `StatusCircle status="prop"`, `ProposedBox`, `AttentionRow proposed`). Applied = solid.
4. **Orb gradient only on the orb** (plus the 20px agent glyph and agent progress fill). Never on buttons, text or cards. Greeting gradient text (`t1 → ac → ai`) is the one text exception, Today header only.
5. **One attention pattern everywhere** (`AttentionRow`: icon · title · why · actions). Don't invent cards for alerts/approvals/inbox items.
6. **Finance is locked by default**: `LockBar` above any finance data (masked amounts until unlocked, "Locked · unlock with passcode").
7. Agent identity = `AgentMark` with per-profile hue (`--ag-cos/mom/dev/lab/jar`); hue is a ring + initial, never a fill behind body text.
8. Borders do the work; shadows only on floating layers (`--sh2`: menus, dialogs, toasts, dock, tray).
9. Every motion is off under `prefers-reduced-motion` (global rule in tokens).
10. Touch targets ≥44px on phone; desktop tier compacts (rows 36, buttons 28).

## 2. Tokens (final values)

Shared: radii `--r1..r4` = 4/6/8/12 · motion `--d1/d2/d3` = 120/160/200 ms, `--ease` = cubic-bezier(.2,0,0,1), `--ease-pop` = cubic-bezier(.3,1.6,.5,1) · fonts `--sans` Geist, `--mono` Geist Mono (self-hosted via `next/font`, CSS vars `--font-geist`, `--font-geist-mono`) · orb `--o1 #3B8070`, `--o2 #3F8F9F`, `--o3 #6F8FE8`, `--orb` = `linear-gradient(135deg, o1 0%, o2 55%, o3 100%)`.

| Token                  | Dark                                            | Light                                           | Role                                           |
| ---------------------- | ----------------------------------------------- | ----------------------------------------------- | ---------------------------------------------- |
| s0                     | #0C0D0F                                         | #F2F3F5                                         | app background                                 |
| s1                     | #121316                                         | #FFFFFF                                         | cards, top bar, rail                           |
| s2                     | #17191C                                         | #F8F8FA                                         | inputs, menus, hover row                       |
| s3                     | #1F2125                                         | #EFF0F3                                         | buttons, selected tree row                     |
| s4                     | #282B30                                         | #E5E7EB                                         | hover on s3, tracks (no t3 text on s4)         |
| bd / bd2               | #23262B / #30343B                               | #E4E5E9 / #D3D6DC                               | dividers (decorative)                          |
| **bdc** (new)          | #70757E                                         | #868B94                                         | control boundary when it's the only cue (≥3:1) |
| t1 / t2 / t3           | #EBECEE / #A3A7AF / **#8A8F97**                 | #14161A / #4E535B / **#5F646D**                 | text 1–3                                       |
| ac                     | #8EA2FF                                         | #3A54D6                                         | accent text/focus/selection                    |
| acb                    | #4B62E0                                         | #3A54D6                                         | primary button/checkbox fill (white text)      |
| acs                    | ac @13%                                         | ac @9%                                          | selected tint                                  |
| **ai**                 | **#4FD8C4** (Lagoon)                            | **#05706B**                                     | agent text/pill/dot/ring                       |
| ais / aib              | ai @10% / @45%                                  | ai @7% / @50%                                   | agent tint / dashed outline                    |
| ok / wn / bad / inf    | #52C48C / #E3A64E / #F0716B / #71AEEF           | **#167449 / #8C5810 / #B83229 / #2563AE**       | semantic (+ `*s` tints)                        |
| ag-cos/mom/dev/lab/jar | #4FD8C4 / #E39A5F / #8EA2FF / #A9BC6B / #EBECEE | #05706B / #B25E1F / #3A54D6 / #5E7220 / #14161A | agent marks                                    |
| sh1 / sh2 / scrim      | see tokens.css                                  |                                                 | elevation                                      |

Bold = changed from design.html. Decisions:

- **Accent:** keep design.html `#8EA2FF`/`#4B62E0` (sea's `#7C9CFF` is within 3% hue; 8EA2FF has higher contrast, 7.75 vs 7.13 on s1). The sea page's `--acc` maps to `--ac`.
- **AI:** dark `#45CDBF` → Lagoon `#4FD8C4`. Light `#08807A` failed 4.5 on s0 (4.32) → `#05706B`.
- design.html light t3/ok/wn/bad/inf and dark t3 were below 4.5 on s0/s3 → darkened/lightened minimally (hue kept).

### Contrast (computed, WCAG relative luminance)

| Pair                        | Dark s0 / s1 / s3                             | Light s0 / s1 / s3 |
| --------------------------- | --------------------------------------------- | ------------------ |
| t1                          | 16.5 / 15.7 / 13.6                            | 16.3 / 18.1 / 15.9 |
| t2                          | 8.1 / 7.7 / 6.7                               | 7.0 / 7.7 / 6.8    |
| t3                          | 6.0 / 5.7 / 5.0                               | 5.4 / 6.0 / 5.2    |
| ac                          | 8.1 / 7.8 / 6.7                               | 5.5 / 6.1 / 5.4    |
| ai                          | 11.1 / 10.6 / 9.2 (8.8 on ais)                | 5.4 / 5.9 / 5.2    |
| ok                          | 8.9 / 8.5 / 7.4                               | 5.2 / 5.8 / 5.1    |
| wn                          | 9.1 / 8.7 / 7.6                               | 5.4 / 6.0 / 5.2    |
| bad                         | 6.7 / 6.4 / 5.6                               | 5.4 / 6.0 / 5.2    |
| inf                         | 8.3 / 8.0 / 6.9                               | 5.4 / 6.0 / 5.3    |
| bdc (UI)                    | 4.2 / 4.0 / 3.5                               | 3.1 / 3.4 / 3.0    |
| white on acb                | 5.1                                           | 6.1                |
| aib outline (UI) on s1      | 3.0                                           | 3.4                |
| white glyph on orb o1/o2/o3 | 4.7 / 3.7 / 3.1 (icon ≥3:1, with drop-shadow) | same               |

## 3. Density tiers

Container queries on the app shell (`container-type: inline-size`), viewport media fallback.

| Tier                                                                                                                                                 | Width                | Row | Two-line row | Button     | Input         | Body    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | --- | ------------ | ---------- | ------------- | ------- |
| phone                                                                                                                                                | <600                 | 44  | 56           | 44 (sm 36) | 44, 16px font | 15px    |
| tablet                                                                                                                                               | 600–1099             | 40  | 52           | 36 (sm 32) | 36            | 14px    |
| desktop                                                                                                                                              | ≥1100 (pointer:fine) | 36  | 48           | 28 (sm 24) | 30            | 13–14px |
| Tailwind variants: `tablet:` (≥600), `desk:` (≥1100); legacy `sm:`/`dense:` keep working. `<html data-density>` pins a tier (Settings › Appearance). |

## 4. Motion

| What                                              | Spec                                                                                                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| hover/press                                       | `--d1` 120ms `--ease`                                                                                                                                 |
| menus, toggles, tabs                              | `--d2` 160ms                                                                                                                                          |
| sheets, dialogs, radial menu                      | `--d3` 200ms, buttons stagger 18ms                                                                                                                    |
| orb                                               | gradient `flow` 7s ease-in-out alternate (bg-size 170%) + aura ring 3.6s ease-out (scale .88→1.28, fade) + glyph twinkle 3.6s; paused while menu open |
| agent card                                        | static low-contrast gradient outline; glow drifts behind content 11s alternate                                                                        |
| live dot                                          | ping 2.4s                                                                                                                                             |
| task check                                        | pop 280ms `--ease-pop` + strike-through 280ms + 10-particle spark burst 600ms (ac, o2, o3, ai)                                                        |
| counts                                            | bump 320ms (translateY 5px→0, fade in)                                                                                                                |
| skeleton                                          | shimmer 1.4s linear                                                                                                                                   |
| All disabled by `prefers-reduced-motion: reduce`. |

## 5. App shell & navigation (PR3)

- **Desktop/tablet (≥600):** one top row (44px, s1): logo · Today · Inbox · Areas · Chat · Alerts · More · spacer · search · split `+ New` (primary) · avatar. Tree rail 256 (desktop) / 224 (tablet, collapsible). Side inspector 300–400 (≥1100 only). Bottom-centre **⌘K command dock** (520 max, s2, sh2) opens the palette.
- **Phone (<600):** sea bottom bar, 64px + safe-area, 5 columns **Today · Areas · [Orb] · Alerts · More**; Inbox and Chat are reached from the orb/More. **Orb** 52px, lifted −20px, `aria-label="Jarvis commands"`, `aria-expanded`. Tap opens the **radial command menu** (scrim `--scrim` + blur 6px; 6 buttons 62px on a 128px semicircle): Search · Capture · Go to · Hand off · Validate · Inbox. Focus moves to the first; Esc/scrim closes and returns focus to the orb; arrow keys cycle. No separate phone dock.
- `nav[aria-label=Primary]` keeps every target ≥44×44 on all tiers (a11y.spec).

## 6. Components (`components/ui/*`, PR2)

All accept `className`; colours only via tokens. Legacy `components/ui.tsx` re-exports/wraps these (Button, Card, Badge→Pill, Kbd, Empty→EmptyState, toast) so pages keep working.

| Component                                                                                                                                                                                                     | Props                                                                                                                              | States                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `Button`                                                                                                                                                                                                      | `variant: primary\|secondary\|ghost\|danger\|agent`, `size: md\|sm`, `icon?`, `iconOnly?`, `loading?`, `asChild/href` (ButtonLink) | hover, focus-visible, active, disabled (45%), loading spinner |
| `SplitButton`                                                                                                                                                                                                 | `label, onClick, menu: MenuItem[], variant`                                                                                        | as Button; menu open                                          |
| `Pill`                                                                                                                                                                                                        | `tone: neutral\|ok\|wn\|bad\|inf\|ac\|ai\|prop\|outline`                                                                           | prop = dashed teal                                            |
| `Dot`                                                                                                                                                                                                         | `tone`, `live?` (ping)                                                                                                             |                                                               |
| `Chip`                                                                                                                                                                                                        | `selected?, onRemove?`                                                                                                             | on, removable                                                 |
| `StatusCircle`                                                                                                                                                                                                | `status: todo\|prog\|done\|block\|prop`, `label`                                                                                   |                                                               |
| `AgentMark`                                                                                                                                                                                                   | `agent: cos\|mom\|dev\|lab\|jar`, `size: sm\|md\|lg`                                                                               | jar = round                                                   |
| `Avatar`                                                                                                                                                                                                      | `initials, size`                                                                                                                   |                                                               |
| `Checkbox`                                                                                                                                                                                                    | `checked, onChange, label, celebrate?`                                                                                             | celebrate = pop + spark                                       |
| `Toggle`                                                                                                                                                                                                      | `checked, onChange, label, locked?`                                                                                                | on, locked                                                    |
| `Segmented`                                                                                                                                                                                                   | `options:{value,label,count?}[], value, onChange, label`                                                                           | radiogroup                                                    |
| `Tabs`                                                                                                                                                                                                        | `tabs:{id,label,count?,href?}[], value, onChange`                                                                                  | tablist, underline                                            |
| `Input`                                                                                                                                                                                                       | native input props + `icon?, invalid?`                                                                                             | focus ring (ac + acs halo), error                             |
| `ProgressBar`                                                                                                                                                                                                 | `value, tone: ac\|ok\|wn\|bad\|ai\|orb, label`                                                                                     | role=progressbar                                              |
| `Skeleton`                                                                                                                                                                                                    | `w, h, className`                                                                                                                  | shimmer                                                       |
| `Menu` / `MenuItem`                                                                                                                                                                                           | `items:{label,onSelect,hint,danger,disabled,heading}[]`                                                                            | roving focus, Esc                                             |
| `Tooltip`                                                                                                                                                                                                     | `content, kbd?`                                                                                                                    | hover/focus                                                   |
| `Toast`                                                                                                                                                                                                       | via `useToast().show({message, action:{label,onClick}})`                                                                           | undo toast                                                    |
| `Row`, `TwoLineRow`                                                                                                                                                                                           | `leading, title, sub, meta, trailing, selected, current, onClick/href`                                                             | hover, sel (acs), cur (2px ac inset)                          |
| `Card`, `CardHeader`, `CardBody`                                                                                                                                                                              | `title, meta, actions`                                                                                                             |                                                               |
| `SectionHeader`                                                                                                                                                                                               | `label, count?, action?`                                                                                                           | uppercase 11px                                                |
| `AttentionRow`                                                                                                                                                                                                | `icon\|agent, tone, title, why, meta, actions, proposed?`                                                                          | prop tint + "Proposed" tag                                    |
| `ProposedBox`                                                                                                                                                                                                 | `label?, children`                                                                                                                 | dashed teal                                                   |
| `Banner`                                                                                                                                                                                                      | `tone: wn\|bad\|inf, children, action`                                                                                             |                                                               |
| `EmptyState`                                                                                                                                                                                                  | `icon, title, children, action`                                                                                                    |                                                               |
| `Kpi`                                                                                                                                                                                                         | `label, value, delta?, tone?`                                                                                                      |                                                               |
| `LockBar`                                                                                                                                                                                                     | `locked, onUnlock, label`                                                                                                          |                                                               |
| `Orb`                                                                                                                                                                                                         | `expanded, onClick, size`                                                                                                          | flow + aura; paused when expanded                             |
| `AgentCard`                                                                                                                                                                                                   | `agent, title, status, live?, children, actions`                                                                                   | gradient outline + drifting glow                              |
| `SpendRing`                                                                                                                                                                                                   | `spent, budget, label`                                                                                                             | ring in `--ai`, tooltip                                       |
| `Kbd`                                                                                                                                                                                                         | children                                                                                                                           |                                                               |
| Later kits (PR8/9): chat msg/tool/composer/autocomplete, `.sui` smart blocks, change tray + undo, calendar strip, counts strip, brief, tree rows (`.tr` drag/drop), markdown `.md`, table `.tbl`, code block. |

## 7. Pages, states, flows, keyboard, decisions

Follow `jarvis-design.html` sections "High-fidelity screens" (22 pages), "States", "Key flows", "Redlines", "Keyboard" and "Open decisions" (defaults adopted). Sea additions on Today: greeting gradient text, counts strip (Left today `--ac` · Need proof `--wn` · From agents `--ai`) with bump, agent cards, spend ring in the header.

## 8. Delivery plan (from design-pass IMPLEMENTATION.md, visuals replaced)

PR1 tokens + Geist + theme/density plumbing → PR2 component kit + `/dev/kit` → PR3 single nav/shell + phone orb/radial + desktop dock → PR4+ pages (Today, Inbox, Areas, Item, Chat, Smart UI, Approvals, More, states, coordinators).
