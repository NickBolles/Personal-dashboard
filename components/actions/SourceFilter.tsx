"use client";

import { sourceFilterOptions, taskSourceLabel } from "@/lib/task-source";
import { ChipSelect } from "@/components/ui";

/** "Source" filter for task lists: one option per source chip label. Hidden with fewer than two sources. */
export function SourceFilter({
  items,
  options: given,
  value,
  onChange,
}: {
  items?: { source: string; sourceLabel?: string }[];
  /** Precomputed labels (e.g. from the server when the list is paged). */
  options?: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  const options = given ?? sourceFilterOptions(items ?? []);
  if (options.length < 2 && !value) return null;
  return (
    <div className="mt-3 flex items-center gap-2 text-sm">
      <ChipSelect aria-label="Source" active={!!value} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All sources</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </ChipSelect>
    </div>
  );
}

export const matchesSource = (value: string) => (a: { source: string; sourceLabel?: string }) => !value || taskSourceLabel(a) === value;
