"use client";

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { Card, ErrorNote, PageHeader, Spinner, useToast } from "@/components/ui";
import { ChipButton, ChipInput, ChipSelect } from "@/components/ui/kit";
import { TAG_COLORS, TAG_COLOR_LABELS, type TagColor, type WorkTag } from "@/lib/item-tags";
import { TagChip, useTagDirectory } from "./ItemMeta";
import { UndoBar, type UndoOp } from "./UndoBar";

/** Settings → Tags (#111): recolour from the token palette, rename, merge (rename onto an existing tag). */
export function TagsSettingsView() {
  const q = useTagDirectory();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // #154: rename/merge is undoable (Renamed #a → #b · Undo)
  const [undo, setUndo] = useState<UndoOp | null>(null);
  const clearUndo = useCallback(() => setUndo(null), []);
  const patch = async (body: { name: string; to?: string; color?: TagColor }) => {
    try {
      const r = await api.patch<{ touched: number; merged: boolean; op?: UndoOp }>("/api/work/tags", body);
      if (body.to && r.op) setUndo({ ...r.op, label: `${r.op.label} (${r.touched} items)` });
      else if (body.to) toast(r.merged ? `Merged into #${body.to} (${r.touched} items)` : `Renamed (${r.touched} items)`, "ok");
      setEditing(null);
      await qc.invalidateQueries({ queryKey: ["work"] });
    } catch (e) {
      toast(`Not saved: ${(e as Error).message}`, "danger");
    }
  };
  return (
    <div className="space-y-3">
      <PageHeader title="Tags" subtitle="Tags are created as you add them to items. Rename onto an existing tag to merge them." />
      <Card>
        {q.isPending ? (
          <Spinner label="Loading tags…" />
        ) : q.error ? (
          <ErrorNote error={q.error} retry={() => q.refetch()} />
        ) : !q.data.tags.length ? (
          <p className="text-[14px] text-muted">No tags yet. Add one from an item&apos;s “+ tag” field or the palette (“Tag …”).</p>
        ) : (
          <ul className="wk-rows" data-testid="tags-list">
            {q.data.tags.map((t: WorkTag) => (
              <li key={t.name} className="flex min-w-0 flex-wrap items-center gap-2 py-2">
                {editing === t.name ? (
                  <form
                    className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void patch({ name: t.name, to: draft });
                    }}
                  >
                    <label htmlFor={`tag-rename-${t.name}`} className="sr-only">
                      New name for {t.name}
                    </label>
                    <ChipInput
                      id={`tag-rename-${t.name}`}
                      className="min-w-0 flex-1 basis-32"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      autoFocus
                    />
                    <ChipButton type="submit" active>
                      Save
                    </ChipButton>
                    <ChipButton onClick={() => setEditing(null)}>Cancel</ChipButton>
                  </form>
                ) : (
                  <>
                    <span className="min-w-0 flex-1">
                      <TagChip name={t.name} color={t.color} />
                      <span className="ml-2 text-xs text-muted tabular-nums">{t.count ?? 0} items</span>
                    </span>
                    <label htmlFor={`tag-color-${t.name}`} className="sr-only">
                      Colour for {t.name}
                    </label>
                    <ChipSelect
                      id={`tag-color-${t.name}`}
                      className="jv-meta-select"
                      value={t.color}
                      onChange={(e) => void patch({ name: t.name, color: e.target.value as TagColor })}
                    >
                      {TAG_COLORS.map((c) => (
                        <option key={c} value={c}>
                          {TAG_COLOR_LABELS[c]}
                        </option>
                      ))}
                    </ChipSelect>
                    <ChipButton
                      aria-label={`Rename or merge ${t.name}`}
                      onClick={() => {
                        setDraft(t.name);
                        setEditing(t.name);
                      }}
                    >
                      Rename
                    </ChipButton>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {undo && <UndoBar key={undo.id} op={undo} onDone={clearUndo} />}
    </div>
  );
}
