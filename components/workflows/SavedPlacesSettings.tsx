"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { Card, ErrorNote, PageHeader, useToast } from "@/components/ui";
import { ChipButton, ChipInput, EmptyState } from "@/components/ui/kit";
import { LoadingState } from "@/components/ui/LoadingState";

type Place = { id: string; label: string; addressText: string | null; radiusM: number; lat: number | null; lng: number | null };

const coords = (p: Place) => (p.lat !== null && p.lng !== null ? `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)} · within ${p.radiusM} m` : "No coordinates saved");

/**
 * Settings → Saved places (#133): the places the workflow Place field and
 * "Use my location" match against. Rename or delete; coordinates only ever
 * show here, on the owner's own device (never in AI context).
 */
export function SavedPlacesSettings() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({
    queryKey: ["workflow-places"],
    queryFn: ({ signal }) => api.get<{ places: Place[]; stripLocation: boolean }>("/api/workflows/places", signal),
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const done = () => qc.invalidateQueries({ queryKey: ["workflow-places"] });
  const rename = async (p: Place) => {
    const label = draft.trim();
    if (!label || label === p.label) return setEditing(null);
    try {
      await api.patch(`/api/workflows/places/${encodeURIComponent(p.id)}`, { label });
      toast(`Renamed to ${label}`, "ok");
      setEditing(null);
      await done();
    } catch (e) {
      toast(`Not saved: ${(e as Error).message}`, "danger");
    }
  };
  const remove = async (p: Place) => {
    try {
      await api.del(`/api/workflows/places/${encodeURIComponent(p.id)}`);
      toast(`Deleted ${p.label}`, "ok");
      setConfirming(null);
      await done();
    } catch (e) {
      toast(`Not deleted: ${(e as Error).message}`, "danger");
    }
  };
  return (
    <div className="space-y-3">
      <PageHeader title="Saved places" subtitle="Places a workflow's Place field can pick, and that “Use my location” matches on this device." />
      <Card>
        {q.isPending ? (
          <LoadingState label="Loading places…" />
        ) : q.error ? (
          <ErrorNote error={q.error} retry={() => q.refetch()} />
        ) : !q.data.places.length ? (
          <EmptyState title="No saved places yet. Save one from a workflow's start form (Place → Save this place)." />
        ) : (
          <ul className="wk-rows" data-testid="places-list">
            {q.data.places.map((p) => (
              <li key={p.id} className="flex min-w-0 flex-wrap items-center gap-2 py-2">
                {editing === p.id ? (
                  <form
                    className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void rename(p);
                    }}
                  >
                    <label htmlFor={`place-rename-${p.id}`} className="sr-only">
                      New name for {p.label}
                    </label>
                    <ChipInput
                      id={`place-rename-${p.id}`}
                      className="min-w-0 flex-1 basis-32"
                      value={draft}
                      maxLength={80}
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
                    <span className="min-w-0 flex-1 break-words">
                      <span className="block font-medium">{p.label}</span>
                      <span className="block text-xs text-muted">
                        {p.addressText ? `${p.addressText} · ` : ""}
                        {coords(p)}
                      </span>
                    </span>
                    {confirming === p.id ? (
                      <>
                        <ChipButton onClick={() => void remove(p)} active aria-label={`Confirm delete ${p.label}`}>
                          Delete
                        </ChipButton>
                        <ChipButton onClick={() => setConfirming(null)}>Keep</ChipButton>
                      </>
                    ) : (
                      <>
                        <ChipButton
                          aria-label={`Rename ${p.label}`}
                          onClick={() => {
                            setDraft(p.label);
                            setEditing(p.id);
                          }}
                        >
                          Rename
                        </ChipButton>
                        <ChipButton aria-label={`Delete ${p.label}`} onClick={() => setConfirming(p.id)}>
                          Delete
                        </ChipButton>
                      </>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {q.data?.stripLocation ? <p className="mt-2 text-xs text-muted">Location stripping is on: new places are saved without coordinates.</p> : null}
      </Card>
    </div>
  );
}
