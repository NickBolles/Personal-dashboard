# Jarvis UI library (`@/components/ui`)

**Rule: every piece of Jarvis UI is built from `@/components/ui`. Lint enforces it.**
The library implements the design system in [design-system.md](design-system.md) (owner's v0 "Command Center" spec + "pine to sea" theme: Tide orb, Lagoon `#4fd8c4` AI accent). Tokens live in `app/globals.css`; component styles are the `.k-*` classes there.

- Import surface: `import { Button, SelectPicker, Field, Input, … } from "@/components/ui";` — never `./kit`, `./legacy`, `./IconAction` directly.
- Gallery (owner-only, visual + a11y tested): **`/dev/ui`** (library pieces app code composes) and **`/dev/kit`** (full design-system kit in both themes). Add new components to one of them in the same PR.
- Enforcement: `eslint-rules/jarvis-ui.mjs` (rules below) + baseline `eslint-suppressions.json`. `npm run ui:baseline` prints what's left; `npm run lint:prune` shrinks the baseline after you migrate call sites. New violations fail `npm run lint` (CI).

## Rules (owner taste)

1. **Library only.** No native `<select>`, `<button>`, `<input>` (except `type=file|hidden`), `<textarea>` outside `components/ui`. No ad-hoc dropdowns/popovers/tabs — use the pickers, `Menu`, `Tabs`.
2. **Tokens only.** No hex colours, no Tailwind arbitrary values (`text-[13px]`, `rounded-[9px]`, `bg-[#…]`); `x-[var(--token)]` is fine. Colours: `var(--ac)`, `text-muted`, `bg-surface-2`, … Blue = you act; Lagoon/teal (`--ai`) = an agent did/proposes it; dashed teal = proposed.
3. **One primary per view** (`Button variant="primary"` or `IconButton tone="primary"`) per page, pane or dialog.
4. **Compact and dense.** No chonky inputs, no default browser styling, no wasted whitespace. Density tiers are built in: phone 44px targets, tablet (≥640) 40/36px, desktop pointer (`dense:`) 28–36px. Don't hand-roll heights.
5. **Writes are confirmed and undoable.** Agent/destructive changes go through a confirm card (`ActionCard`/`ProposedBox`) and every write shows **Undo** (`UndoBar` for server ops, `Toast action`). Never auto-settle.
6. **Import/export in every module** (settings and data pages expose both, via `Menu` items, not extra primary buttons).
7. **Accessibility.** Targets ≥44px phone / ≥40px desktop for primary nav and icon actions (≥24px minimum anywhere); every icon-only control has a name (`IconButton label`, `Button iconOnly` with text child); pages reflow at 320px and **200% text zoom**; all motion off under `prefers-reduced-motion` (global rule); no emoji in UI text.
8. **Foldable phone first.** Pickers open as bottom sheets on phones (lifted above the keyboard), popovers on desktop.

## Components

| Need                                    | Use                                                                                                                              | Notes / don't                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Action                                  | `Button` (`variant` primary/secondary/ghost/danger/agent, `size` md/sm, `icon`, `iconOnly`, `loading`)                           | Default `type="button"`: pass `type="submit"` for form submit. `agent` = teal agent action. |
| Link styled as action                   | `ButtonLink` (`external` adds new-tab + sr text)                                                                                 |                                                                                             |
| Icon-only header/card action            | `IconButton` (`label` = accessible name + tooltip, `icon`, `tone="primary"`, `dot` running/waiting/failed, `busy`)               | Glyph is `aria-hidden`.                                                                     |
| Overflow / more actions                 | `Menu` + `KMenuItem[]`; split primary: `SplitButton`                                                                             | Not `OverflowMenu` (legacy).                                                                |
| Card / row actions menu (anchored)      | `useAnchoredMenu()` + `MenuButton` (visible ⋯) + `AnchoredMenu`; spread `menu.surfaceProps` on the card/row                      | Right-click, long press (touch) and Menu key/Shift+F10 open the same menu. See below.       |
| Choose one value (status, model, area…) | `SelectPicker` (`label`, `value`, `options[{value,label,dot?,section?}]`, `onChange`)                                            | Popover desktop / sheet phone, search appears above 7 options. Not native `<select>`.       |
| Choose many / labels / assignee         | `MetaPicker` (`multi`, `onToggle`, `onCreate`)                                                                                   | GitHub-label style.                                                                         |
| Due date                                | `DuePicker` (`value`, `onSave`)                                                                                                  | Quick dates + calendar.                                                                     |
| Filter chips in toolbars                | `ChipSelect` (transitional, native underneath — give data-listing chips a fixed width), `ChipInput`, `ChipButton`, `Segmented`   | Prefer `SelectPicker` for new code.                                                         |
| Form field                              | `Field` (`id`, `label`, `hint`, `error`) wrapping `Input` / `Textarea` / `Select` / `SelectPicker`                               | `Input` has `icon`, `invalid`. Not `inputCls`.                                              |
| Booleans                                | `Checkbox`, `Toggle`                                                                                                             | Optimistic toggles keep a local override until the response.                                |
| Tabs                                    | `Tabs` (`tabs[{id,label,count?,href?}]`, `value`, `onChange`, `label`)                                                           | One tab bar per pane.                                                                       |
| Dialog / sheet                          | `Dialog` (focus trap + restore); confirm writes with a confirm card                                                              | One primary inside.                                                                         |
| Feedback                                | `useToast()` (status toasts), `UndoBar` (`@/components/work/UndoBar`, server undo ops), presentational `Toast` (`action` = Undo) | Every write → confirmation + Undo.                                                          |
| Status atoms                            | `Pill` (tones neutral/ok/wn/bad/inf/ac/ai/prop/outline), `Dot`, `StatusCircle`, `Chip`, `Kbd`                                    | Not `Badge` (legacy).                                                                       |
| Containers                              | `Card` + `CardHeader`/`CardBody`, `SectionHeader`, `Row`/`TwoLineRow`, `AttentionRow`                                            | One attention pattern everywhere.                                                           |
| States                                  | `LoadingState`/`Skeleton`, `EmptyState`, `ErrorNote` (`retry`), `Banner`                                                         | Not `Empty`/`Spinner` (legacy); `KSpinner` for inline busy.                                 |
| Agent identity                          | `AgentMark`, `AgentCard`, `Orb`, `SpendRing`, `ProposedBox`                                                                      | Orb gradient only on the orb.                                                               |
| Finance                                 | `LockBar`, `PermissionLock`                                                                                                      | Locked by default.                                                                          |
| Page frame                              | `Page`, `PageHeader`                                                                                                             | Exactly one `<h1>` per page.                                                                |

## Anchored menu (cards, rows, the tray)

`components/ui/AnchoredMenu.tsx`, on `/dev/ui` ("Anchored menu"). One primitive for "every action of this card":

- **Open:** the visible ⋯ `MenuButton` (kit icon button, full hit area) — always render it, a long press is only an accelerator; right-click; a long press on touch (500 ms, cancelled by a 10 px move, the lift is swallowed); the Menu key / Shift+F10 on a focused control inside the surface.
- **Place:** top layer (Popover API) or fixed, at the trigger (below, end-aligned) or at the pointer, flipped/clamped to the viewport. Width is the `--k-menu-w` token (rem), labels wrap — never a hard-coded px width or ellipsis (200% text).
- **Close:** Esc, choosing an item, a pointer outside, scroll, resize. **Focus returns** to the control that opened it (the ⋯ trigger, or the focused control in the surface, else the surface's ⋯), unless the chosen action moved focus on purpose.
- Don't hand-roll positioned `Menu`s (`position:absolute; left: var(--x)`), outside-click listeners or `scrollIntoView` hacks around a menu.

## Superseded (lint-banned for new code, being migrated)

`Button`/`ButtonLink`/`Card`/`Kbd` from `@/components/ui/legacy` → kit versions; `Badge` → `Pill`; `Empty` → `EmptyState`; `Spinner` → `KSpinner`/`LoadingState`; `OverflowMenu` → `Menu`; `SectionLabel` → `SectionHeader`; `inputCls` + raw inputs → `Field` + `Input`/`Textarea`; native `<select>` → `Select` in forms (native underneath, `selectOption` keeps working), `SelectPicker` for inline row/header pickers. See `/opt/data/worktrees/jarvis-ui-standardize-AUDIT.md` (audit) for call sites.

## Justified exceptions

Bespoke surfaces that genuinely need a raw element (chat composer textarea with keyboard inset, tree rows with roving focus, the nav rail/orb) may keep it with a one-line reason:
`{/* eslint-disable-next-line jarvis-ui/no-native-controls -- composer: auto-grow + kb inset */}`. Prefer extending the library instead.

## Adding to the library

Put the component in `components/ui/` (styles as `.k-*` in `app/globals.css`, tokens only, all three density tiers), export it from `components/ui/index.ts`, show it on `/dev/ui`, document it in the table above, and run the visual baselines once.
