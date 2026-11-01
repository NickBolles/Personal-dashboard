"use client";

import type { ActionDef, Chip } from "@/lib/palette";

/** The typed action's name + filled argument chips, shown inside the input before the caret (Raycast-style). */
export function PaletteChips({ def, chips }: { def: ActionDef; chips: Chip[] }) {
  return (
    <span className="flex shrink-0 flex-wrap items-center gap-1" data-testid="palette-chips">
      <span className="text-sm font-medium text-accent">{def.label}</span>
      {chips.map((c, i) => (
        <span
          key={`${c.arg.name}:${i}`}
          className="inline-flex max-w-[12rem] items-center gap-1 truncate rounded-[6px] border border-line bg-accent-soft px-1.5 py-0.5 text-sm"
          aria-label={`${c.arg.name}: ${c.value.label}`}
        >
          <span className="text-xs text-muted">{c.arg.name}</span>
          <span className="truncate font-medium">{c.value.label}</span>
        </span>
      ))}
    </span>
  );
}

export type PanelEntry = { id: string; label: string; hint?: string; run: () => void };

/** ⌘K / long-press action panel for one row. */
export function PaletteActionPanel({
  title,
  entries,
  active,
  onActive,
  listId,
}: {
  title: string;
  entries: PanelEntry[];
  active: number;
  onActive: (i: number) => void;
  listId: string;
}) {
  return (
    <div className="border-t border-line bg-surface p-1.5" data-testid="palette-actions">
      <p className="eyebrow truncate px-2.5 pb-1 pt-1">Actions · {title}</p>
      <ul id={listId} role="menu" aria-label={`Actions for ${title}`}>
        {entries.map((e, i) => (
          <li
            key={e.id}
            id={`${listId}-${i}`}
            role="menuitem"
            tabIndex={-1}
            aria-current={i === active ? "true" : undefined}
            onMouseEnter={() => onActive(i)}
            onClick={e.run}
            className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-[8px] px-2.5 py-1.5 sm:min-h-10 dense:min-h-8 ${i === active ? "bg-accent-soft" : ""}`}
          >
            <span className="min-w-0 flex-1 truncate font-medium">{e.label}</span>
            {e.hint ? (
              <span aria-hidden="true" className="shrink-0 text-xs text-muted">
                {e.hint}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
