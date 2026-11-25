# Palette interaction delta

Continuation of the shipped [Raycast palette](https://artifacts.ai.nickbolles.com/v/jarvis-raycast-palette-20261101/) / PR #102, tracked by `wk_17dbd5b5-965d-4229-ae26-db2abf33a241`. This is not a new navigation hierarchy.

## Convention

| Entry | Behavior |
| --- | --- |
| Orb tap / Ctrl or Cmd+K | Search by default, existing actions and `/workflow` syntax still available |
| `>` / Ctrl or Cmd+Shift+P | Commands only; editable prefix remains in the same input |
| `?` | **Proposed reversible default:** Ask Chief of staff, in the existing global/pinned Chief thread |
| Typed action | Existing argument chips plus a visible `> Action` parent trail |
| Visible Back / empty-input Backspace | Move within the palette hierarchy |
| Prominent Close / Esc / browser Back | Dismiss the entire popup, including subcommands, menu and confirmation |

No `!` trigger. Selecting a different mode keeps the query; it never sends, navigates, creates a conversation or runs a command. Prefix-only Ask and IME composition never submit. Prefix syntax is recognized only at the root: a typed task title that starts with `?` or `>` is literal text.

Search no longer guesses that a multi-word query means “send to an agent.” Search/results remain ahead of the Ask affordance. Explicit `?`, choosing the Ask row or Ctrl/Cmd+Enter all use **one** Chief destination, staging the question for review in its composer, not sending it or creating a scoped chat. An existing Chief draft is retained with the new question appended. The page attachment and pinned conversation routing stay owned by the existing coordinator. Explicit area-specific typed Ask commands remain scoped actions.

## Dismissal and history

A single same-URL history entry is added while the palette is open, retaining Next's router state. Subcommands never add history entries. Browser Back consumes that one entry and closes the whole overlay. Button/Esc dismissal waits for the real traversal before running a selected navigation, so a delayed Back cannot undo the chosen route. Reopening adds just one new entry. Reloading an open palette consumes its stale entry rather than leaving an invisible Back stop.

Underlying page URL (including query/hash) and existing draft remain untouched by dismissal. Focus returns to the opener. Inner Back is deliberately a different control from Close.

**Android distinction:** browser-history traversal is covered by Playwright, not physical Android hardware. Android may consume the first Back to hide the software keyboard without emitting `popstate`; in that case the palette remains open until the next Back. We do not intercept the OS keyboard dismissal or claim physical-device verification.

## Boundaries

Reuse the existing sheet, rows, action definitions, confirmation and shared UI primitives. No routes, schema, permissions, agent configuration or deployment changes. No production chat sends. Visual evidence uses the real mock-backed app at 320/412px and desktop 200% text; it is not a live authenticated-owner smoke.
