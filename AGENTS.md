<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## UI rules (all agents: Claude, Codex, Copilot, Hermes)

Jarvis UI is built ONLY from the component library `@/components/ui` (docs/ui-library.md), which implements the design system (docs/design-system.md: Command Center + Tide/Lagoon tokens). `npm run lint` enforces this (`eslint-rules/jarvis-ui.mjs`); existing legacy call sites are baselined in `eslint-suppressions.json` and must only shrink.

- Always import UI from `@/components/ui` (never `@/components/ui/kit`, `/legacy`, `/IconAction`). Never use native `<select>`, `<button>`, `<input>` (except file/hidden) or `<textarea>`: use `SelectPicker`/`MetaPicker`/`DuePicker`, `Button`/`IconButton`/`ChipButton`/`Menu`, `Field` + `Input`/`Textarea`, `Checkbox`/`Toggle`/`Segmented`, `Tabs`.
- Tokens only: no hex colours, no Tailwind arbitrary values (`text-[13px]`); `x-[var(--token)]` is fine. Blue = you act, Lagoon teal (`--ai`) = agent, dashed teal = proposed.
- Exactly one primary action per view (page, pane, dialog). Compact, dense, premium: no chonky inputs, no default browser styling, no wasted whitespace; use the built-in density tiers, never hand-rolled heights.
- Writes are confirmed and undoable (confirm card + Undo); never auto-settle. Every module offers import/export.
- A11y: targets ≥44px on phones / ≥40px desktop for nav and icon actions (≥24px anywhere); icon-only controls need a name; reflow at 320px and 200% text zoom; motion off under `prefers-reduced-motion`; no emoji in UI text. Foldable phone is the primary form factor (pickers = bottom sheets on phones).
- **Design for the owner’s device first** (owner, 2026-11-10): a Galaxy Z Fold 6 at normal zoom, closed (cover screen ≈ 368×850 CSS px) and unfolded (≈ 706×822, the 600–899 tablet tier). Verify there before anything else (`npm run ux:shots -- --only cover,unfolded`). Controls stay light: icon, ghost or quiet text actions with modest type, tap area kept by hit-slop rather than a big box (see the "sleek controls" block in `components/coordinator/coordinator.css`). 320px / 200% text reflow must not break, but it does not drive the design.
- Missing a component? Add it to `components/ui/` (tokens, `.k-*` styles, density tiers), export it from `components/ui/index.ts`, show it on `/dev/ui`, document it in docs/ui-library.md. Migrated legacy call sites? Run `npm run lint:prune` and commit the smaller `eslint-suppressions.json`. `npm run ui:baseline` shows what's left.
