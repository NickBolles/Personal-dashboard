"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, newIdempotencyKey } from "@/lib/client/api";
import type { HomePayload, JarvisNotification } from "@/lib/contracts";
import type { RunView, SessionSummary, TimelineItem } from "@/lib/hermes";
import { Button, Dialog, Field, Spinner, cx, inputCls, useToast } from "@/components/ui";
import { shareableWithHermes } from "@/lib/privacy";

export function RenameDialog({ open, onClose, session }: { open: boolean; onClose: () => void; session: SessionSummary }) {
  const [title, setTitle] = useState(session.title);
  const qc = useQueryClient();
  const { toast } = useToast();
  useEffect(() => setTitle(session.title), [session.title, open]);
  const m = useMutation({
    mutationFn: () => api.patch(`/api/hermes/sessions/${encodeURIComponent(session.id)}`, { title: title.trim() || null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["session", session.id] });
      qc.invalidateQueries({ queryKey: ["sessions"] });
      toast("Renamed", "ok");
      onClose();
    },
    onError: (e) => toast((e as Error).message, "danger"),
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Rename conversation"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={m.isPending} onClick={() => m.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <Field id="rename-title" label="Title">
        <input
          id="rename-title"
          data-autofocus
          className={inputCls}
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && m.mutate()}
        />
      </Field>
    </Dialog>
  );
}

export function ForkDialog({
  open,
  onClose,
  session,
  fromMessage,
}: {
  open: boolean;
  onClose: () => void;
  session: SessionSummary;
  fromMessage?: TimelineItem;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [key] = useState(() => newIdempotencyKey("fork"));
  useEffect(() => {
    if (open) {
      setTitle(`${session.title} (fork)`);
      setPrompt("");
    }
  }, [open, session.title]);
  const needsPrompt = Boolean(fromMessage);
  const m = useMutation({
    mutationFn: () =>
      api.post<{ session: SessionSummary; run?: RunView }>(`/api/hermes/sessions/${encodeURIComponent(session.id)}/fork`, {
        title: title.trim() || undefined,
        fromMessageId: fromMessage?.id,
        prompt: prompt.trim() || undefined,
        idempotencyKey: key,
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["sessions"] });
      qc.invalidateQueries({ queryKey: ["session", session.id] });
      toast("Fork created. The original conversation is unchanged.", "ok");
      onClose();
      router.push(`/chat/${encodeURIComponent(res.session.id)}${res.run ? `?run=${encodeURIComponent(res.run.runId)}` : ""}`);
    },
    onError: (e) => toast((e as Error).message, "danger"),
  });
  const preview = fromMessage && "text" in fromMessage ? fromMessage.text : undefined;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={fromMessage ? "Fork from this message" : "Fork latest state"}
      description={
        fromMessage
          ? "Starts a new conversation that carries the context up to and including the selected message."
          : "Starts a new conversation with a copy of the full transcript."
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={m.isPending} disabled={needsPrompt && !prompt.trim()} onClick={() => m.mutate()}>
            Create fork
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="rounded-xl bg-ok-soft p-3 text-sm text-ok">
          The original conversation’s messages stay exactly as they are. Both conversations link to each other.
        </p>
        {preview ? (
          <div className="rounded-xl border border-line bg-surface-2 p-3">
            <p className="text-xs font-medium text-muted">Fork point</p>
            <p className="prose-chat mt-1 line-clamp-4 text-sm">{preview}</p>
          </div>
        ) : null}
        <Field id="fork-title" label="Title (optional)">
          <input id="fork-title" data-autofocus className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </Field>
        <Field
          id="fork-prompt"
          label={needsPrompt ? "First prompt" : "First prompt (optional)"}
          hint={needsPrompt ? "Required: the context is sent together with your first message." : undefined}
        >
          <textarea id="fork-prompt" rows={3} className={inputCls} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

export function ModelDialog({
  open,
  onClose,
  value,
  onChange,
}: {
  open: boolean;
  onClose: () => void;
  value: { model?: string; provider?: string };
  onChange: (v: { model?: string; provider?: string }) => void;
}) {
  const caps = useQuery({
    queryKey: ["hermes", "capabilities"],
    queryFn: () => api.get<{ model?: string; provider?: string; providers: { id?: string; name?: string }[] }>("/api/hermes/capabilities"),
    enabled: open,
  });
  const [model, setModel] = useState(value.model ?? "");
  const [provider, setProvider] = useState(value.provider ?? "");
  useEffect(() => {
    if (open) {
      setModel(value.model ?? "");
      setProvider(value.provider ?? "");
    }
  }, [open, value.model, value.provider]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Model for this conversation"
      description={
        caps.data?.model
          ? `Hermes default: ${caps.data.provider ? `${caps.data.provider} / ` : ""}${caps.data.model}`
          : "Leave blank to use the Hermes default."
      }
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              onChange({});
              onClose();
            }}
          >
            Use default
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onChange({ model: model.trim() || undefined, provider: provider.trim() || undefined });
              onClose();
            }}
          >
            Apply
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field id="m-provider" label="Provider">
          <input
            id="m-provider"
            list="m-providers"
            className={inputCls}
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            placeholder="e.g. anthropic"
          />
          <datalist id="m-providers">
            {(caps.data?.providers ?? []).map((p, i) => (
              <option key={p.id ?? i} value={p.id ?? ""}>
                {p.name}
              </option>
            ))}
          </datalist>
        </Field>
        <Field id="m-model" label="Model">
          <input id="m-model" data-autofocus className={inputCls} value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. claude-sonnet-4" />
        </Field>
      </div>
    </Dialog>
  );
}

/** Attach an action, alert, or Paperclip issue as context for the next message. */
export function ContextPicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (label: string, ref: string) => void }) {
  const home = useQuery({ queryKey: ["home", "cached"], queryFn: () => api.get<HomePayload>("/api/home?cached=1"), enabled: open });
  const alerts = useQuery({
    queryKey: ["notifications", "inbox"],
    queryFn: () => api.get<{ notifications: JarvisNotification[] }>("/api/notifications"),
    enabled: open,
  });
  // Home data never goes to the AI layer (lib/privacy.ts).
  const actions = [...(home.data?.now ?? []), ...(home.data?.later.laterToday ?? []), ...(home.data?.later.upcoming ?? [])]
    .filter((a) => shareableWithHermes(a.source))
    .slice(0, 12);
  const alertItems = (alerts.data?.notifications ?? []).filter((n) => shareableWithHermes(n.source));
  const pick = (label: string, ref: string) => {
    onPick(label, ref);
    onClose();
  };
  return (
    <Dialog open={open} onClose={onClose} title="Attach context" description="Hermes receives a short reference with your next message." size="lg">
      {home.isLoading || alerts.isLoading ? <Spinner label="Loading…" /> : null}
      <h3 className="mb-1 text-sm font-semibold">Actions</h3>
      <ul className="mb-4 space-y-1">
        {actions.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              onClick={() => pick(a.title, `${a.source}:${a.sourceId}`)}
              className="min-h-11 w-full rounded-lg px-3 text-left text-sm hover:bg-surface-2"
            >
              {a.title} <span className="text-muted">· {a.source}</span>
            </button>
          </li>
        ))}
        {!actions.length && !home.isLoading ? <li className="text-sm text-muted">No actions.</li> : null}
      </ul>
      <h3 className="mb-1 text-sm font-semibold">Alerts</h3>
      <ul className="space-y-1">
        {alertItems.slice(0, 10).map((n) => (
          <li key={n.id}>
            <button
              type="button"
              onClick={() => pick(n.title, `alert:${n.id}`)}
              className="min-h-11 w-full rounded-lg px-3 text-left text-sm hover:bg-surface-2"
            >
              {n.title}
            </button>
          </li>
        ))}
        {!alertItems.length && !alerts.isLoading ? <li className="text-sm text-muted">No alerts.</li> : null}
      </ul>
    </Dialog>
  );
}

type SearchResult = { id: string; identifier: string; title: string; status: string; url: string; parentId?: string };

/** Search-first "Track in Paperclip": link existing, create initiative, or create bounded child. */
export function TrackDialog({ open, onClose, session }: { open: boolean; onClose: () => void; session: SessionSummary }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [mode, setMode] = useState<"search" | "create" | "child">("search");
  const [parent, setParent] = useState<SearchResult>();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const listId = useId();
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    if (open) {
      setMode("search");
      setQ(session.title);
      setTitle(session.title);
      setParent(undefined);
    }
  }, [open, session.title]);
  const results = useQuery({
    queryKey: ["paperclip", "search", debounced],
    queryFn: () => api.get<{ results: SearchResult[] }>(`/api/paperclip/search?q=${encodeURIComponent(debounced)}`),
    enabled: open && debounced.trim().length >= 2,
  });
  const m = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<{ issue: { identifier: string }; created: boolean; deduplicated: boolean }>("/api/paperclip/track", { sessionId: session.id, ...body }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["session", session.id] });
      qc.invalidateQueries({ queryKey: ["initiatives"] });
      toast(
        res.created ? `Created ${res.issue.identifier} and linked it` : `Linked to ${res.issue.identifier}${res.deduplicated ? " (already existed)" : ""}`,
        "ok",
      );
      onClose();
    },
    onError: (e) => toast((e as Error).message, "danger"),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Track in Paperclip"
      description="Search first so the same initiative is reused across conversations."
    >
      {mode === "search" ? (
        <div className="space-y-3">
          <Field id="pc-search" label="Search Paperclip issues">
            <input id="pc-search" data-autofocus className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} aria-controls={listId} />
          </Field>
          {results.isFetching ? <Spinner label="Searching…" /> : null}
          {results.error ? <p className="text-sm text-danger">{(results.error as Error).message}</p> : null}
          <ul id={listId} className="max-h-72 space-y-1 overflow-y-auto" aria-label="Search results">
            {(results.data?.results ?? []).map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2">
                <span className="min-w-0 flex-1 text-sm">
                  <span className="font-mono text-xs text-muted">{r.identifier}</span> {r.title}{" "}
                  <span className="text-xs text-muted">· {r.status.replace("_", " ")}</span>
                </span>
                <Button
                  size="sm"
                  onClick={() => m.mutate({ mode: "link", issueId: r.id, relationship: "related_to" })}
                  busy={m.isPending}
                  aria-label={`Link to ${r.identifier}`}
                >
                  Link
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setParent(r);
                    setMode("child");
                  }}
                  aria-label={`Create child under ${r.identifier}`}
                >
                  Add child
                </Button>
              </li>
            ))}
          </ul>
          {results.data && !results.data.results.length ? <p className="text-sm text-muted">No matching issues.</p> : null}
          <div className="flex justify-between gap-2 border-t border-line pt-3">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => setMode("create")}>Create new initiative</Button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate(mode === "child" ? { mode: "child", parentId: parent!.id, title, description } : { mode: "create", title, description });
          }}
        >
          {mode === "child" && parent ? (
            <p className="text-sm">
              Child of <span className="font-mono">{parent.identifier}</span> {parent.title}
            </p>
          ) : null}
          <Field id="pc-title" label="Title">
            <input id="pc-title" data-autofocus required minLength={3} className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field id="pc-desc" label="Description (optional)" hint="Paperclip gets one backlink to this conversation.">
            <textarea id="pc-desc" rows={3} className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <div className={cx("flex justify-between gap-2 border-t border-line pt-3")}>
            <Button type="button" variant="ghost" onClick={() => setMode("search")}>
              Back to search
            </Button>
            <Button type="submit" variant="primary" busy={m.isPending}>
              {mode === "child" ? "Create child and link" : "Create and link"}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
