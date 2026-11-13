/**
 * Jarvis UI library — the ONE import surface for UI (`import { … } from "@/components/ui"`).
 *
 * Built on the design system (docs/design-system.md: Command Center + Tide/Lagoon tokens) and
 * documented in docs/ui-library.md; every piece is on the owner-only gallery at /dev/ui.
 * Lint (`jarvis-ui/*` rules in eslint.config.mjs) bans native controls, hex colours and
 * arbitrary Tailwind values outside this folder, and imports of the superseded primitives
 * in `./legacy` (Badge, Empty, Spinner, legacy Button/ButtonLink/Card/Kbd, OverflowMenu,
 * SectionLabel, inputCls). Existing call sites are listed in eslint-suppressions.json and
 * are being burned down to zero — never add new ones.
 */

// Design-system kit: buttons, menus, chips, pills, form controls, rows, cards, states.
export * from "./kit";

// Anchored menu: ⋯ trigger + right-click / long-press / Menu key, collision-aware, focus returns to the opener.
export { AnchoredMenu, MenuButton, useAnchoredMenu, type AnchoredMenuState } from "./AnchoredMenu";

// Icon-only header/card actions with tooltip + live-state dot.
export { IconAction, IconAction as IconButton, CoordinatorGlyph, FocusGlyph, type IconActionDot } from "./IconAction";

// The one row for a decision (D-n), a piece of work (R-n) or an item: what it is, then its state; icon actions; opens in place.
export { ThingRow, StateDot, StateWord, RefPill, RowAction, type ThingState } from "./ThingRow";

// Bottom-sheet grab bar: drag up for full height, down to close; the bar is also a button and takes arrow keys.
export { SheetHandle, useSheetDrag } from "./SheetDrag";

// Loading state (named status + skeletons).
export { LoadingState } from "./LoadingState";

// Inline pickers (GitHub-label style: popover on desktop, sheet on phones, search above 7 options).
export {
  MetaPicker,
  SelectPicker,
  DuePicker,
  StatusPickerDot,
  AreaPickerDot,
  TagIcon,
  PersonIcon,
  quickDueDates,
  DUE_EDIT_SETTLE_MS,
  type PickerOption,
  type SelectPickerOption,
} from "@/components/work/MetaPicker";

// Shell + infrastructure primitives (no kit replacement; canonical).
export { Page, PageHeader, Dialog, ToastProvider, useToast, useOnline, useNow, Field, ErrorNote, SourceBadge, AssigneeChip } from "./legacy";
