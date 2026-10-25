"use client";

import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { relativeTime } from "@/lib/time";
import { Button, Card, ErrorNote, Spinner, useToast } from "@/components/ui";

type Shared = { conversations: { id: string; title: string; lastActiveAt: string | null }[]; unavailable: string[] };

/** Your conversations shared with the household (read-only for them), with Stop sharing. Share/unshare is audited. */
export function SharedConversations() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["sessions", "shared"], queryFn: () => api.get<Shared>("/api/hermes/sessions/shared") });
  const stop = useMutation({
    mutationFn: (id: string) => api.patch(`/api/hermes/sessions/${encodeURIComponent(id)}`, { shared: false }),
    onSuccess: () => {
      toast("Stopped sharing", "ok");
      qc.invalidateQueries({ queryKey: ["sessions"] });
      qc.invalidateQueries({ queryKey: ["session"] });
    },
    onError: (e) => toast((e as Error).message, "danger"),
  });
  const list = q.data?.conversations ?? [];
  return (
    <Card>
      <h2 className="eyebrow mb-1">Shared conversations</h2>
      <p className="mb-2 text-sm text-muted">Others in the household can read and fork these; only you can continue them.</p>
      {q.isPending ? <Spinner label="Loading…" /> : null}
      {q.error ? <ErrorNote error={q.error} retry={() => q.refetch()} /> : null}
      {q.data && !list.length ? <p className="text-sm text-muted">You aren&apos;t sharing any conversations.</p> : null}
      {list.length ? (
        <ul className="rows" aria-label="Shared conversations">
          {list.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
              <div className="min-w-0">
                <Link href={`/chat/${encodeURIComponent(c.id)}`} className="font-medium break-words hover:underline">
                  {c.title}
                </Link>
                {c.lastActiveAt ? (
                  <p className="text-xs text-muted" data-dynamic>
                    {relativeTime(c.lastActiveAt)}
                  </p>
                ) : null}
              </div>
              <Button size="sm" onClick={() => stop.mutate(c.id)} busy={stop.isPending && stop.variables === c.id} aria-label={`Stop sharing ${c.title}`}>
                Stop sharing
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
