"use client";

import { Button, type MenuItem } from "@/components/ui";

/** Shortcuts use the exact overflow handlers; they only open existing review dialogs. No new mutation path. */
export function ItemAiChips({ aiActions, itemActions }: { aiActions: MenuItem[]; itemActions: MenuItem[] }) {
  if (!aiActions.length) return null; // Existing API policy + capability gate, including per-area AI exclusions.
  const draft = aiActions.find((a) => /Draft it/.test(a.label));
  const actions = [
    draft ? { ...draft, label: "Draft next step" } : null,
    // No summarize handler exists yet: do not fake it with a different AI action.
    itemActions.find((a) => a.label === "Split into child") ? { ...itemActions.find((a) => a.label === "Split into child")!, label: "Split" } : null,
    itemActions.find((a) => a.label === "Move…") ? { ...itemActions.find((a) => a.label === "Move…")!, label: "Move" } : null,
  ].filter((a): a is MenuItem => !!a);
  return (
    <div role="group" aria-label="AI shortcuts" className="mt-2 hidden min-w-0 flex-wrap gap-1 min-[413px]:flex">
      {actions.map((a) => (
        <Button
          key={a.label}
          type="button"
          variant="ghost"
          size="sm"
          className="text-ai"
          disabled={a.disabled}
          aria-label={`AI: ${a.label}`}
          onClick={a.onSelect}
        >
          {a.label}
        </Button>
      ))}
    </div>
  );
}
