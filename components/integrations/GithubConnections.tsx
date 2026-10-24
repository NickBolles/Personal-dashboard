"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { fineGrainedTokenUrl, parseRepoList, type GithubSettingsResponse, type GithubTestResult, type PublicGithubConnection } from "@/lib/github";
import { Badge, Button, Dialog, ErrorNote, Field, Spinner, cx, inputCls, useToast } from "@/components/ui";
import { CheckIcon } from "@/components/icons";

/**
 * Settings → Connections → GitHub (admin). One read-only token per GitHub
 * owner; tokens are write-only (only "•••• last4" ever comes back). Plus the
 * webhook URL and secret (shown once when generated) and the poll interval.
 */
const KEY = ["github", "settings"];

function useGithubMutation<V, R = unknown>(fn: (v: V) => Promise<R>, opts: { ok?: string; onSuccess?: (r: R) => void } = {}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      if (opts.ok) toast(opts.ok, "ok");
      qc.invalidateQueries({ queryKey: KEY });
      opts.onSuccess?.(r);
    },
    onError: (e) => toast((e as Error).message, "danger"),
  });
}

export function GithubConnections() {
  const q = useQuery({ queryKey: KEY, queryFn: () => api.get<GithubSettingsResponse>("/api/github") });
  const [adding, setAdding] = useState(false);
  if (q.isPending) return <Spinner label="Loading GitHub settings…" />;
  if (q.error) return <ErrorNote error={q.error} retry={() => q.refetch()} />;
  const s = q.data;
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        Read-only access for the Work hub: linked PR and issue state, and issues assigned to you (into the Work inbox). Jarvis only ever reads; it never writes
        to GitHub. Add one token per GitHub owner (your user, each organization).
      </p>
      {s.envToken ? (
        <p className="rounded-lg bg-surface-2 p-2 text-sm">
          <Badge>Fallback</Badge> <code>JARVIS_GITHUB_TOKEN</code> is set on the server and is used for owners without a connection.
        </p>
      ) : null}

      <section aria-labelledby="gh-tokens">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 id="gh-tokens" className="font-semibold">
            Tokens
          </h3>
          <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
            Add token
          </Button>
        </div>
        {s.connections.length ? (
          <ul className="space-y-3" aria-label="GitHub connections">
            {s.connections.map((c) => (
              <ConnectionRow key={c.id} c={c} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No GitHub tokens yet.</p>
        )}
      </section>

      <TokenHelp />
      <WebhookSettings s={s} />
      <PollSettings key={s.pollMinutes} s={s} />
      {adding ? <ConnectionDialog onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

function TokenHelp() {
  const [owner, setOwner] = useState("");
  return (
    <details className="rounded-lg border border-line p-3 text-sm">
      <summary className="tap cursor-pointer font-medium text-accent">How to create a read-only token</summary>
      <ol className="mt-2 list-decimal space-y-1 pl-5">
        <li>Use a fine-grained personal access token, one per owner, with only Pull requests: Read and Issues: Read.</li>
        <li>Pick the owner (your user or the organization) and the repositories Jarvis may read.</li>
        <li>Paste the token here, then press Test.</li>
      </ol>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <Field id="gh-help-owner" label="Owner for the link">
            <input id="gh-help-owner" className={inputCls} value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="momentumbets" />
          </Field>
        </div>
        <a
          href={fineGrainedTokenUrl(owner.trim())}
          target="_blank"
          rel="noreferrer noopener"
          className="tap inline-flex min-h-11 items-center text-accent underline"
          data-testid="gh-token-link"
        >
          Open GitHub’s token form<span className="sr-only"> (opens in a new tab)</span>
        </a>
      </div>
      <p className="mt-2 text-xs break-all text-muted">{fineGrainedTokenUrl(owner.trim() || "<owner>")}</p>
    </details>
  );
}

export function GithubTestResults({ result }: { result: GithubTestResult }) {
  const warn = result.warnings.length > 0;
  return (
    <div
      role="status"
      className={cx("rounded-xl border p-3 text-sm", !result.ok ? "border-danger bg-danger-soft" : warn ? "border-warn bg-warn-soft" : "border-ok bg-ok-soft")}
    >
      <p className={cx("font-semibold", !result.ok ? "text-danger" : warn ? "text-warn" : "text-ok")}>{result.summary}</p>
      {result.warnings.map((w) => (
        <p key={w} className="mt-1 font-semibold text-warn" data-testid="gh-warning">
          {w}
        </p>
      ))}
      <ul className="mt-2 space-y-1">
        {result.checks.map((c) => (
          <li key={c.name} className="flex items-start gap-2">
            <span aria-hidden="true" className={c.ok ? "text-ok" : "text-danger"}>
              {c.ok ? <CheckIcon className="h-4 w-4" /> : "✕"}
            </span>
            <span className="min-w-0 break-words">
              <span className="font-medium">{c.name}</span>
              <span className="sr-only">{c.ok ? " passed" : " failed"}</span>
              {c.detail ? <span className="text-muted"> — {c.detail}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted">
        Token type: {result.tokenType === "fine_grained" ? "fine-grained" : result.tokenType}
        {result.scopes ? ` · scopes: ${result.scopes.join(", ") || "none"}` : " · scopes: not reported (fine-grained tokens)"}
        {result.permissions.length
          ? ` · your role: ${result.permissions.map((p) => `${p.repo} ${p.admin ? "admin" : p.push ? "write" : p.pull ? "read" : "none"}`).join(", ")}`
          : ""}
      </p>
      <p className="mt-1 text-xs text-muted">Checked {new Date(result.checkedAt).toLocaleString()}</p>
    </div>
  );
}

function ConnectionRow({ c }: { c: PublicGithubConnection }) {
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const test = useGithubMutation(() => api.post<GithubTestResult>(`/api/github/connections/${encodeURIComponent(c.id)}/test`));
  const remove = useGithubMutation(() => api.del(`/api/github/connections/${encodeURIComponent(c.id)}`), { ok: "Token removed" });
  const last = test.data ?? c.lastTest;
  return (
    <li className="rounded-lg border border-line p-3" data-testid="gh-connection">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium break-words">{c.label}</p>
          <p className="text-sm text-muted">
            Owner <span className="font-medium text-text">{c.owner}</span> · token <span className="font-mono">{c.tokenHint}</span>
            {c.login ? ` · ${c.login}` : ""}
          </p>
          <p className="text-xs break-words text-muted">{c.repos.length ? `Repos: ${c.repos.join(", ")}` : "All repositories the token can see"}</p>
        </div>
        {!last ? (
          <Badge tone="warn">Untested</Badge>
        ) : last.ok && !last.warnings.length ? (
          <Badge tone="ok">Read-only</Badge>
        ) : last.ok ? (
          <Badge tone="warn">Can write</Badge>
        ) : (
          <Badge tone="danger">Failing</Badge>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => test.mutate(undefined)} busy={test.isPending} aria-label={`Test ${c.label}`}>
          Test
        </Button>
        <Button size="sm" onClick={() => setEditing(true)} aria-label={`Edit ${c.label}`}>
          Edit
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirm(true)} aria-label={`Remove ${c.label}`}>
          Remove
        </Button>
      </div>
      {last ? (
        <div className="mt-2">
          <GithubTestResults result={last} />
        </div>
      ) : null}
      {editing ? <ConnectionDialog c={c} onClose={() => setEditing(false)} /> : null}
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Remove ${c.label}?`}
        description="Jarvis forgets the token. Links to this owner's PRs stop refreshing (unless JARVIS_GITHUB_TOKEN is set)."
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="danger" busy={remove.isPending} onClick={() => remove.mutate(undefined)}>
              Remove token
            </Button>
          </>
        }
      />
    </li>
  );
}

function ConnectionDialog({ c, onClose }: { c?: PublicGithubConnection; onClose: () => void }) {
  const [label, setLabel] = useState(c?.label ?? "");
  const [owner, setOwner] = useState(c?.owner ?? "");
  const [token, setToken] = useState("");
  const [repos, setRepos] = useState(c?.repos.join(", ") ?? "");
  const save = useGithubMutation(
    () =>
      c
        ? api.patch(`/api/github/connections/${encodeURIComponent(c.id)}`, { label, owner, repos: parseRepoList(repos), ...(token ? { token } : {}) })
        : api.post("/api/github/connections", { label, owner, token, repos: parseRepoList(repos) }),
    { ok: c ? "Saved" : "Token saved. Press Test to check it.", onSuccess: onClose },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={c ? `Edit ${c.label}` : "Add a GitHub token"}
      description="Stored encrypted on the Jarvis server. It's never shown again after you save."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="gh-conn-form" busy={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form
        id="gh-conn-form"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(undefined);
        }}
      >
        <Field id="gh-label" label="Label">
          <input
            id="gh-label"
            data-autofocus
            required
            className={inputCls}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Momentum (org)"
          />
        </Field>
        <Field id="gh-owner" label="Owner (user or organization)">
          <input id="gh-owner" required className={inputCls} value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="momentumbets" />
        </Field>
        <Field id="gh-token" label={c ? "Replace token (optional)" : "Token"} hint={c ? `Current: ${c.tokenHint}. Leave empty to keep it.` : "Write-only."}>
          <input
            id="gh-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            required={!c}
            className={inputCls}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </Field>
        <Field id="gh-repos" label="Repository allowlist (optional)" hint="Comma-separated repository names. Empty: every repository the token can see.">
          <input id="gh-repos" className={inputCls} value={repos} onChange={(e) => setRepos(e.target.value)} placeholder="momentum-web, odds-feed" />
        </Field>
      </form>
    </Dialog>
  );
}

function WebhookSettings({ s }: { s: GithubSettingsResponse }) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const { toast } = useToast();
  const gen = useGithubMutation(() => api.post<{ secret: string; createdAt: string }>("/api/github/webhook-secret"), {
    onSuccess: (r) => {
      setRevealed(r.secret);
      setConfirm(false);
    },
  });
  const url = `${typeof window === "undefined" ? "" : window.location.origin}${s.webhook.path}`;
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copied`, "ok");
    } catch {
      toast("Couldn't copy; select the text instead", "warn");
    }
  };
  return (
    <section aria-labelledby="gh-webhook" className="space-y-2">
      <h3 id="gh-webhook" className="font-semibold">
        Webhook (optional, read-only)
      </h3>
      <p className="text-sm text-muted">
        GitHub can tell Jarvis the moment a linked PR or issue changes. Jarvis doesn&apos;t register it for you: in the repository or organization settings, add
        a webhook with this URL, content type <code>application/json</code>, this secret, and the events “Pull requests” and “Issues”. Jarvis checks the
        signature on every delivery and only updates PRs and issues already linked to Work items.
      </p>
      <Field id="gh-webhook-url" label="Payload URL">
        <div className="flex gap-2">
          <input id="gh-webhook-url" readOnly className={cx(inputCls, "font-mono text-xs")} value={url} />
          <Button size="sm" onClick={() => copy(url, "URL")}>
            Copy
          </Button>
        </div>
      </Field>
      {revealed ? (
        <div className="rounded-lg border border-warn bg-warn-soft p-3 text-sm" role="status">
          <p className="font-semibold">Copy the secret now: it won&apos;t be shown again.</p>
          <div className="mt-2 flex gap-2">
            <label htmlFor="gh-secret" className="sr-only">
              Webhook secret
            </label>
            <input id="gh-secret" readOnly className={cx(inputCls, "font-mono text-xs")} value={revealed} data-testid="gh-secret" />
            <Button size="sm" onClick={() => copy(revealed, "Secret")}>
              Copy
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm">
          Secret:{" "}
          {s.webhook.secretSet ? (
            <span>
              set{s.webhook.secretCreatedAt ? ` on ${new Date(s.webhook.secretCreatedAt).toLocaleDateString()}` : ""} (hidden). Regenerate to see a new one.
            </span>
          ) : (
            <span>not set. Deliveries are refused until you generate one.</span>
          )}
        </p>
      )}
      <Button size="sm" onClick={() => (s.webhook.secretSet ? setConfirm(true) : gen.mutate(undefined))} busy={gen.isPending && !confirm}>
        {s.webhook.secretSet ? "Regenerate secret" : "Generate secret"}
      </Button>
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Regenerate the webhook secret?"
        description="Deliveries signed with the old secret will be refused until you paste the new one into GitHub."
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="primary" busy={gen.isPending} onClick={() => gen.mutate(undefined)}>
              Regenerate
            </Button>
          </>
        }
      />
    </section>
  );
}

function PollSettings({ s }: { s: GithubSettingsResponse }) {
  const [minutes, setMinutes] = useState(String(s.pollMinutes));
  const save = useGithubMutation(() => api.patch("/api/github", { pollMinutes: Number(minutes) }), { ok: "Saved" });
  return (
    <section aria-labelledby="gh-poll" className="space-y-2">
      <h3 id="gh-poll" className="font-semibold">
        Scheduled check
      </h3>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(undefined);
        }}
      >
        <div className="w-40">
          <Field id="gh-poll-minutes" label="Every (minutes)">
            <input
              id="gh-poll-minutes"
              type="number"
              min={0}
              max={1440}
              step={1}
              className={inputCls}
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
            />
          </Field>
        </div>
        <Button type="submit" size="sm" busy={save.isPending} disabled={minutes === String(s.pollMinutes) || minutes === ""}>
          Save
        </Button>
      </form>
      <p className="text-xs text-muted">
        0 turns it off. At most 50 links per check, each at most every 5 minutes; Jarvis waits when GitHub rate-limits.{" "}
        {s.poller.running ? "Running" : "Not running"}
        {s.poller.lastTickAt ? ` · last check ${new Date(s.poller.lastTickAt).toLocaleTimeString()}: ${s.poller.lastResult ?? ""}` : ""}.
      </p>
    </section>
  );
}
