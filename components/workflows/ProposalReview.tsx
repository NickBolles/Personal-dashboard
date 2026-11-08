"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { Button, Field, Textarea, cx, useToast } from "@/components/ui";
import { PROPOSAL_PARTS, proposalSchema, validateProposal, type PartDecision, type ProposalPart, type WorkflowProposal } from "@/lib/workflows/proposal";

const PART_LABEL: Record<ProposalPart, string> = {
  basics: "Name & basics",
  instructions: "Instructions",
  capture: "Capture fields",
  startForm: "Start form",
};

type Source = { kind: "chat"; sessionId: string } | { kind: "describe"; description: string };

/** Fetches an AI draft (proposal only) and shows the review. */
export function DraftReview({ source, onCancel }: { source: Source; onCancel?: () => void }) {
  const q = useQuery({
    queryKey: ["workflow-draft", source],
    queryFn: () => api.post<{ proposal: WorkflowProposal }>("/api/workflows/draft", source),
    retry: false,
    staleTime: Infinity,
  });
  if (q.isLoading) return <p className="text-sm text-muted">Drafting a workflow from {source.kind === "chat" ? "this chat" : "your description"}…</p>;
  if (q.error)
    return (
      <div role="alert" className="space-y-2 text-sm">
        <p className="text-danger">{(q.error as Error).message}</p>
        {onCancel ? (
          <Button type="button" onClick={onCancel}>
            Back
          </Button>
        ) : null}
      </div>
    );
  return <ProposalReview proposal={q.data!.proposal} onCancel={onCancel} />;
}

/** Review screen: each proposed part with Keep / Edit / Drop; validator issues inline; Save as draft (never activates). */
export function ProposalReview({ proposal: initial, onCancel }: { proposal: WorkflowProposal; onCancel?: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [proposal, setProposal] = useState<WorkflowProposal>(initial);
  const parts = PROPOSAL_PARTS.filter((p) => proposal[p] !== undefined);
  const [decisions, setDecisions] = useState<Partial<Record<ProposalPart, PartDecision>>>(() => Object.fromEntries(parts.map((p) => [p, "accept"])));
  const [editing, setEditing] = useState<ProposalPart | null>(null);
  const [text, setText] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const result = useMemo(() => validateProposal(proposal, decisions), [proposal, decisions]);
  const issuesFor = (p: ProposalPart | null) => (result.ok ? [] : result.issues.filter((i) => i.part === p));

  const startEdit = (p: ProposalPart) => {
    setEditing(p);
    setEditError(null);
    setText(p === "instructions" ? (proposal.instructions ?? "") : JSON.stringify(proposal[p], null, 2));
  };
  const applyEdit = () => {
    if (!editing) return;
    try {
      const value = editing === "instructions" ? text : JSON.parse(text);
      // Shape-check the edited part before it reaches state, so the card never renders an invalid value.
      const parsed = proposalSchema.shape[editing].safeParse(value);
      if (!parsed.success) {
        setEditError(`That doesn't look like a valid ${editing === "startForm" ? "start form" : editing}: ${parsed.error.issues[0]?.message ?? "wrong shape"}`);
        return;
      }
      setProposal((cur) => ({ ...cur, [editing]: value }));
      setDecisions((d) => ({ ...d, [editing]: "accept" }));
      setEditing(null);
    } catch {
      setEditError("That isn't valid JSON");
    }
  };

  const save = async () => {
    if (!result.ok) return;
    setSaving(true);
    setServerError(null);
    try {
      const r = await api.post<{ workflow: { slug: string } }>("/api/workflows", { definition: result.definition, changeNote: "Drafted by AI" });
      toast("Saved as a draft. Turn it on from Workflows when it's ready.");
      await qc.invalidateQueries({ queryKey: ["workflows"] });
      router.replace(`/workflows/${r.workflow.slug}/edit`);
    } catch (err) {
      setServerError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby="wf-review-h" className="space-y-3" data-testid="proposal-review">
      <h2 id="wf-review-h" className="text-lg font-semibold">
        Review the proposed workflow
      </h2>
      <p className="text-sm text-muted">Keep, edit or drop each part. Nothing is saved until you tap Save as draft, and it stays off until you turn it on.</p>
      {proposal.rationale ? <p className="text-sm">{proposal.rationale}</p> : null}
      {issuesFor(null).length ? (
        <div role="alert">
          <ul className="space-y-1 text-sm text-danger">
            {issuesFor(null).map((i, n) => (
              <li key={n}>{i.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <ul className="space-y-3">
        {parts.map((p) => {
          const dropped = decisions[p] === "drop";
          const issues = issuesFor(p);
          return (
            <li
              key={p}
              aria-label={PART_LABEL[p]}
              className={cx("min-w-0 rounded-xl border border-dashed border-[var(--aib)] p-3", dropped && "opacity-60")}
              data-part={p}
            >
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">
                  {PART_LABEL[p]}
                  {dropped ? <span className="ml-2 text-xs font-normal text-muted">Dropped</span> : null}
                </h3>
                <div className="flex flex-wrap gap-2" role="group" aria-label={`${PART_LABEL[p]} decision`}>
                  <Button type="button" size="sm" aria-pressed={!dropped} onClick={() => setDecisions((d) => ({ ...d, [p]: "accept" }))}>
                    Keep
                  </Button>
                  <Button type="button" size="sm" onClick={() => startEdit(p)}>
                    Edit
                  </Button>
                  <Button type="button" size="sm" aria-pressed={dropped} onClick={() => setDecisions((d) => ({ ...d, [p]: "drop" }))}>
                    Drop
                  </Button>
                </div>
              </div>
              {editing === p ? (
                <div className="mt-2 space-y-2">
                  <Field id={`wf-review-${p}`} label={`Edit ${PART_LABEL[p].toLowerCase()}`} error={editError ?? undefined}>
                    <Textarea
                      id={`wf-review-${p}`}
                      className="min-h-32 w-full min-w-0 font-mono text-xs"
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                    />
                  </Field>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" onClick={applyEdit}>
                      Apply
                    </Button>
                    <Button type="button" size="sm" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <PartBody part={p} proposal={proposal} />
              )}
              {issues.length ? (
                <div role="alert">
                  <ul className="mt-2 space-y-1 text-sm text-danger">
                    {issues.map((i, n) => (
                      <li key={n}>{i.message}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {serverError ? (
        <p role="alert" className="text-sm text-danger">
          {serverError}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="primary" className="whitespace-normal" onClick={() => void save()} disabled={!result.ok || saving || !!editing}>
          {saving ? "Saving…" : "Save as draft"}
        </Button>
        {onCancel ? (
          <Button type="button" onClick={onCancel}>
            Discard
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function PartBody({ part, proposal }: { part: ProposalPart; proposal: WorkflowProposal }) {
  if (part === "basics" && proposal.basics)
    return (
      <dl className="mt-2 grid grid-cols-1 gap-1 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
        <dt className="text-muted">Name</dt>
        <dd className="min-w-0 break-words">{proposal.basics.name}</dd>
        <dt className="text-muted">Command</dt>
        <dd className="min-w-0 break-words">/{proposal.basics.slug}</dd>
        {proposal.basics.description ? (
          <>
            <dt className="text-muted">Description</dt>
            <dd className="min-w-0 break-words">{proposal.basics.description}</dd>
          </>
        ) : null}
        <dt className="text-muted">Area</dt>
        <dd className="min-w-0 break-words">{proposal.basics.area || "Miscellaneous"}</dd>
      </dl>
    );
  if (part === "instructions") return <p className="mt-2 whitespace-pre-wrap break-words text-sm">{proposal.instructions}</p>;
  if (part === "capture" && proposal.capture)
    return (
      <ul className="mt-2 space-y-1 text-sm">
        {Object.entries(proposal.capture).map(([k, v]) => (
          <li key={k} className="min-w-0 break-words">
            <span className="font-medium">{k}</span> <span className="text-muted">{describeSlot(v)}</span>
          </li>
        ))}
      </ul>
    );
  if (part === "startForm" && proposal.startForm)
    return (
      <div className="mt-2 text-sm">
        {proposal.startForm.title ? <p className="font-medium">{proposal.startForm.title}</p> : null}
        <ul className="space-y-1">
          {(Array.isArray(proposal.startForm.fields) ? proposal.startForm.fields : []).map((f, n) => {
            const field = f as { id?: string; label?: string; type?: string };
            return (
              <li key={field.id ?? n} className="min-w-0 break-words">
                {field.label ?? field.id} <span className="text-muted">({field.type})</span>
              </li>
            );
          })}
        </ul>
      </div>
    );
  return null;
}

function describeSlot(v: unknown): string {
  if (typeof v === "string") return v;
  const o = v as { type?: string; of?: unknown; fields?: Record<string, unknown> };
  if (o?.type === "list") return `list of ${typeof o.of === "string" ? o.of : "items"}`;
  if (o?.type === "object") return `fields: ${Object.keys(o.fields ?? {}).join(", ")}`;
  return o?.type ?? "";
}
