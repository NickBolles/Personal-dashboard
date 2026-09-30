"use client";

import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import type { InitiativeCard, IssueCard } from "@/integrations/paperclip/service";
import { Badge, Button, ButtonLink, Card, Empty, ErrorNote, PageHeader, Spinner, useToast, type Tone } from "@/components/ui";

const STATUS_TONE: Record<string, Tone> = { blocked: "danger", in_review: "warn", in_progress: "accent", done: "ok", todo: "neutral", backlog: "neutral" };

function Status({ s }: { s: string }) {
  return <Badge tone={STATUS_TONE[s] ?? "neutral"}>{s.replace("_", " ")}</Badge>;
}

function IssueLink({ i }: { i: IssueCard }) {
  return (
    <a href={i.url} target="_blank" rel="noreferrer noopener" className="hover:underline">
      <span className="font-mono text-xs text-muted">{i.identifier}</span> {i.title}
      <span className="sr-only"> (opens Paperclip)</span>
    </a>
  );
}

export function InitiativesView() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({
    queryKey: ["initiatives"],
    queryFn: () => api.get<{ initiatives: InitiativeCard[]; myWork: IssueCard[]; paperclipUrl: string }>("/api/paperclip/initiatives"),
  });
  const unlink = useMutation({
    mutationFn: (id: string) => api.del(`/api/paperclip/links/${id}`),
    onSuccess: () => {
      toast("Unlinked. Nothing changed in Paperclip.", "ok");
      qc.invalidateQueries({ queryKey: ["initiatives"] });
    },
  });
  return (
    <div className="mx-auto max-w-3xl px-4 py-5 sm:px-6">
      <PageHeader
        title="Initiatives"
        subtitle="Paperclip owns status, blockers and assignments. Jarvis shows them and links conversations."
        actions={q.data ? <ButtonLink href={q.data.paperclipUrl} external>Open Paperclip</ButtonLink> : null}
      />
      {q.isLoading ? <Spinner label="Loading from Paperclip…" /> : null}
      {q.error ? (
        (q.error as { status?: number }).status === 501 ? (
          <Empty title="Paperclip isn’t connected" action={<Link className="underline" href="/settings/connections">Connect Paperclip</Link>} />
        ) : (
          <ErrorNote error={q.error} retry={() => q.refetch()} />
        )
      ) : null}
      {q.data ? (
        <>
          <section aria-labelledby="mine-h" className="mb-6">
            <h2 id="mine-h" className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
              My active work
            </h2>
            {q.data.myWork.length ? (
              <ul className="card divide-y divide-line">
                {q.data.myWork.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                    <IssueLink i={i} />
                    <Status s={i.status} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">Nothing assigned to you.</p>
            )}
          </section>
          <section aria-labelledby="init-h">
            <h2 id="init-h" className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
              Initiatives
            </h2>
            {!q.data.initiatives.length ? <p className="text-sm text-muted">No open initiatives. Use “Track in Paperclip” from a conversation.</p> : null}
            <ul className="space-y-3">
              {q.data.initiatives.map((it) => {
                const pct = it.progress.total ? Math.round((it.progress.done / it.progress.total) * 100) : 0;
                return (
                  <li key={it.id}>
                    <Card as="article" aria-labelledby={`init-${it.id}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-muted">{it.identifier}</span>
                        <Status s={it.status} />
                        {it.owner ? <span className="text-xs text-muted">Owner: {it.owner.replace(/^(user|agent):/, "$1 ")}</span> : null}
                      </div>
                      <h3 id={`init-${it.id}`} className="mt-1 text-lg font-semibold">
                        {it.title}
                      </h3>
                      <div className="mt-2">
                        <div className="flex justify-between text-xs text-muted">
                          <span>Progress (from Paperclip children)</span>
                          <span>
                            {it.progress.done} of {it.progress.total} done
                          </span>
                        </div>
                        <div className="mt-1 h-2 rounded-full bg-surface-2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${it.title} progress`}>
                          <div className="h-2 rounded-full bg-accent" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                      {it.nextChild ? (
                        <p className="mt-3 text-sm">
                          <span className="text-muted">Next: </span>
                          <IssueLink i={it.nextChild} />
                        </p>
                      ) : null}
                      {it.blockers.length ? (
                        <div className="mt-3">
                          <p className="text-sm font-medium text-danger">Blocked ({it.blockers.length})</p>
                          <ul className="mt-1 space-y-1 text-sm">
                            {it.blockers.map((b) => (
                              <li key={b.id}>
                                <IssueLink i={b} />
                                {b.blockedBy.length ? (
                                  <span className="text-muted">
                                    {" "}
                                    — waiting on{" "}
                                    {b.blockedBy.map((x, idx) => (
                                      <span key={x.id}>
                                        {idx ? ", " : ""}
                                        <IssueLink i={x} />
                                      </span>
                                    ))}
                                  </span>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      <div className="mt-3">
                        <p className="text-sm font-medium">Related conversations</p>
                        {it.relatedSessions.length ? (
                          <ul className="mt-1 space-y-1">
                            {it.relatedSessions.map((r) => (
                              <li key={r.linkId} className="flex flex-wrap items-center gap-2 text-sm">
                                <Link className="underline" href={`/chat/${encodeURIComponent(r.sessionId)}`}>
                                  Continue conversation
                                </Link>
                                <span className="text-xs text-muted">{r.relationship.replace("_", " ")}</span>
                                <Button size="sm" variant="ghost" onClick={() => unlink.mutate(r.linkId)} aria-label="Unlink conversation">
                                  Unlink
                                </Button>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="text-sm text-muted">None linked yet.</p>
                        )}
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <ButtonLink href={it.url} external>
                          Open in Paperclip
                        </ButtonLink>
                        <ButtonLink href={`/chat?new=1&context=${encodeURIComponent(`Paperclip initiative ${it.identifier}: ${it.title}`)}`}>Discuss with Hermes</ButtonLink>
                      </div>
                    </Card>
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      ) : null}
    </div>
  );
}
