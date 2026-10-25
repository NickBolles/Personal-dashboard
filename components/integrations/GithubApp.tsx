"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { APP_CALLBACK_MESSAGES, APP_NAME_MAX, parseRepoList, type GithubSettingsResponse, type PublicGithubApp } from "@/lib/github";
import { Badge, Button, ButtonLink, Dialog, Field, cx, inputCls, useToast } from "@/components/ui";

/**
 * Settings → Connections → GitHub → GitHub App (admin). "Create GitHub App"
 * runs GitHub's manifest flow from this browser: Jarvis prepares the manifest
 * and a one-time state, the browser POSTs it to GitHub, you confirm there
 * (passkey/password: Jarvis never sees it), and GitHub sends you back to
 * /api/github/app/callback. The App's credentials stay on the server.
 */
const KEY = ["github", "settings"];

/** Build and submit the manifest form (GitHub requires a top-level POST with a `manifest` field). */
function postManifest(action: string, manifest: string) {
  const form = document.createElement("form");
  form.method = "post";
  form.action = action;
  form.hidden = true;
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "manifest";
  input.value = manifest;
  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
}

function useCallbackNotice() {
  // Read once: ?github_app=<outcome> from the callback / GitHub's setup redirect.
  const [notice] = useState(() => {
    if (typeof window === "undefined") return null;
    const v = new URLSearchParams(window.location.search).get("github_app");
    return v && APP_CALLBACK_MESSAGES[v] ? v : null;
  });
  useEffect(() => {
    if (notice) window.history.replaceState(null, "", `${window.location.pathname}#github`);
  }, [notice]);
  return notice;
}

export function GithubAppSection({ s }: { s: GithubSettingsResponse }) {
  const notice = useCallbackNotice();
  const ok = notice === "created" || notice === "installed";
  return (
    <section aria-labelledby="gh-app" className="space-y-3 rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="gh-app" className="font-semibold">
          GitHub App (recommended)
        </h3>
        <Badge tone="ok">Read-only</Badge>
      </div>
      {notice ? (
        <p role="status" data-testid="gh-app-notice" className={cx("rounded-lg p-2 text-sm", ok ? "bg-ok-soft text-ok" : "bg-danger-soft text-danger")}>
          {APP_CALLBACK_MESSAGES[notice]}
        </p>
      ) : null}
      {s.app ? <AppDetails app={s.app} autoRefresh={notice === "installed" || notice === "created"} /> : <CreateApp s={s} />}
    </section>
  );
}

function CreateApp({ s }: { s: GithubSettingsResponse }) {
  const { toast } = useToast();
  const [name, setName] = useState(s.appSetup.defaultName);
  const [target, setTarget] = useState<"user" | "org">("user");
  const [org, setOrg] = useState("");
  const create = useMutation({
    mutationFn: () => api.post<{ action: string; manifest: string }>("/api/github/app/manifest", { name, target, ...(target === "org" ? { org } : {}) }),
    onSuccess: (r) => postManifest(r.action, r.manifest),
    onError: (e) => toast((e as Error).message, "danger"),
  });
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted">
        One App replaces per-owner tokens: install it on your account and on each organization. It can only read (metadata, pull requests, issues, checks,
        commit statuses, actions) and sends webhooks for pull requests, reviews, issues, check suites and workflow runs. GitHub asks you to confirm with your
        passkey or password; Jarvis never sees it, and the App&apos;s keys stay on the server.
      </p>
      {!s.appSetup.https ? (
        <p className="rounded-lg bg-warn-soft p-2 text-warn" data-testid="gh-app-http-warning">
          This page isn&apos;t served over https ({s.appSetup.origin}). GitHub can&apos;t deliver webhooks here; open Jarvis at its public https address (or set{" "}
          <code>JARVIS_PUBLIC_ORIGIN</code>) before creating the App.
        </p>
      ) : null}
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Field id="gh-app-name" label="App name" hint={`Must be unique on GitHub, up to ${APP_NAME_MAX} characters.`}>
          <input id="gh-app-name" required maxLength={APP_NAME_MAX} className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">Create it under</legend>
          <label className="tap flex min-h-11 items-center gap-2">
            <input type="radio" name="gh-app-target" value="user" checked={target === "user"} onChange={() => setTarget("user")} />
            My GitHub account
          </label>
          <label className="tap flex min-h-11 items-center gap-2">
            <input type="radio" name="gh-app-target" value="org" checked={target === "org"} onChange={() => setTarget("org")} />
            An organization
          </label>
        </fieldset>
        {target === "org" ? (
          <Field id="gh-app-org" label="Organization">
            <input id="gh-app-org" required className={inputCls} value={org} onChange={(e) => setOrg(e.target.value)} placeholder="momentumbets" />
          </Field>
        ) : null}
        <p className="text-xs break-all text-muted">
          GitHub will send you back to {s.appSetup.callbackUrl}; webhooks go to {s.appSetup.webhookUrl}. The App is public so it can be installed on your
          account and your organizations; only accounts in the allowlist are used.
        </p>
        <Button type="submit" variant="primary" busy={create.isPending}>
          Create GitHub App
        </Button>
      </form>
      <ConnectExisting />
    </div>
  );
}

/** Read a .pem file into the textarea (stays in the browser until Connect). */
async function readPemFile(file: File | undefined) {
  if (!file || file.size > 10_000) return null;
  return (await file.text()).trim();
}

function ConnectExisting() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [appId, setAppId] = useState("");
  const [pem, setPem] = useState("");
  const [secret, setSecret] = useState("");
  const connect = useMutation({
    mutationFn: () => api.post("/api/github/app/connect", { appId: Number(appId), pem, ...(secret ? { webhookSecret: secret } : {}) }),
    onSuccess: () => {
      setPem("");
      setSecret("");
      toast("GitHub App connected", "ok");
      qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => toast((e as Error).message, "danger"),
  });
  return (
    <details className="rounded-lg border border-line p-3">
      <summary className="tap cursor-pointer font-medium text-accent">Already have an App? Connect it</summary>
      <form
        className="mt-2 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          connect.mutate();
        }}
      >
        <p className="text-muted">Jarvis checks the App ID and private key with GitHub before saving. Both secrets are write-only.</p>
        <Field id="gh-app-id" label="App ID">
          <input id="gh-app-id" required inputMode="numeric" pattern="[0-9]+" className={inputCls} value={appId} onChange={(e) => setAppId(e.target.value)} />
        </Field>
        <Field id="gh-app-pem" label="Private key (.pem)" hint="Paste it or choose the file GitHub downloaded.">
          <textarea
            id="gh-app-pem"
            required
            rows={4}
            spellCheck={false}
            autoComplete="off"
            className={cx(inputCls, "font-mono text-xs")}
            value={pem}
            onChange={(e) => setPem(e.target.value)}
          />
        </Field>
        <div>
          <label htmlFor="gh-app-pem-file" className="block text-sm font-medium">
            Or choose the .pem file
          </label>
          <input
            id="gh-app-pem-file"
            type="file"
            accept=".pem,application/x-pem-file"
            className="mt-1 block min-h-11 text-sm"
            onChange={async (e) => {
              const text = await readPemFile(e.target.files?.[0]);
              if (text) setPem(text);
              e.target.value = "";
            }}
          />
        </div>
        <Field id="gh-app-secret" label="Webhook secret (optional)" hint="The secret set on the App's webhook. Write-only.">
          <input id="gh-app-secret" type="password" autoComplete="off" className={inputCls} value={secret} onChange={(e) => setSecret(e.target.value)} />
        </Field>
        <Button type="submit" busy={connect.isPending}>
          Connect App
        </Button>
      </form>
    </details>
  );
}

function WebhookSecretForm({ set }: { set: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [secret, setSecret] = useState("");
  const save = useMutation({
    mutationFn: () => api.patch("/api/github/app", { webhookSecret: secret }),
    onSuccess: () => {
      setSecret("");
      toast("Webhook secret saved", "ok");
      qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => toast((e as Error).message, "danger"),
  });
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="min-w-0 flex-1">
        <Field id="gh-app-hook-secret" label={set ? "Replace the App's webhook secret" : "App webhook secret"} hint="Write-only.">
          <input
            id="gh-app-hook-secret"
            type="password"
            autoComplete="off"
            required
            className={inputCls}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </Field>
      </div>
      <Button type="submit" size="sm" busy={save.isPending}>
        Save secret
      </Button>
    </form>
  );
}

function AppDetails({ app, autoRefresh }: { app: PublicGithubApp; autoRefresh: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [confirm, setConfirm] = useState(false);
  const refresh = useMutation({
    mutationFn: () => api.post<{ app: PublicGithubApp }>("/api/github/app/installations/refresh"),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
    onError: (e) => {
      toast((e as Error).message, "danger");
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
  const forget = useMutation({
    mutationFn: () => api.del("/api/github/app"),
    onSuccess: () => {
      toast("GitHub App forgotten. Delete it on GitHub too.", "ok");
      setConfirm(false);
      qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => toast((e as Error).message, "danger"),
  });
  const started = useRef(false);
  useEffect(() => {
    if (autoRefresh && !started.current) {
      started.current = true;
      refresh.mutate();
    }
  }, [autoRefresh, refresh]);
  return (
    <div className="space-y-3 text-sm" data-testid="gh-app">
      <div>
        <p className="font-medium break-words">
          <a href={app.htmlUrl} target="_blank" rel="noreferrer noopener" className="text-accent underline">
            {app.name}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </p>
        <p className="text-muted">
          Owned by <span className="font-medium text-text">{app.owner}</span> · App ID {app.appId} · created {new Date(app.createdAt).toLocaleDateString()}
        </p>
        {!app.webhookSecretSet ? <p className="mt-1 text-warn">No App webhook secret saved: App webhooks are refused until you save it below.</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <ButtonLink href={app.installUrl} external variant="primary" className="min-h-11 px-3 text-sm" data-testid="gh-app-install">
          Install on GitHub
        </ButtonLink>
        <Button size="sm" onClick={() => refresh.mutate()} busy={refresh.isPending}>
          Refresh installations
        </Button>
      </div>
      <p className="text-muted">Install it on your account and on each organization (e.g. momentumbets), then press Refresh.</p>

      <div>
        <h4 className="font-medium">Installations</h4>
        {app.installations.length ? (
          <ul className="mt-1 space-y-2" aria-label="GitHub App installations">
            {app.installations.map((i) => (
              <li key={i.id} className="rounded-lg border border-line p-2" data-testid="gh-installation">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">
                    {i.account} <span className="text-xs font-normal text-muted">({i.accountType === "Organization" ? "organization" : "user"})</span>
                  </p>
                  <span className="flex flex-wrap gap-1">
                    {i.allowed ? <Badge tone="ok">In use</Badge> : <Badge tone="danger">Ignored: not in the allowlist</Badge>}
                    {i.suspended ? <Badge tone="warn">Suspended</Badge> : null}
                  </span>
                </div>
                <p className="text-xs break-words text-muted">
                  {i.repositorySelection === "all"
                    ? "All repositories"
                    : i.repos === null
                      ? "Selected repositories (not read yet — press Refresh)"
                      : i.repos.length
                        ? `Repos: ${i.repos.join(", ")}`
                        : "No repositories selected"}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted">Not installed anywhere yet.</p>
        )}
        {app.lastRefresh ? (
          <p className={cx("mt-1 text-xs", app.lastRefresh.ok ? "text-muted" : "text-danger")} data-testid="gh-app-refresh">
            Last read {new Date(app.lastRefresh.at).toLocaleString()}: {app.lastRefresh.detail}
          </p>
        ) : null}
      </div>

      <WebhookSecretForm set={app.webhookSecretSet} />

      <AllowlistForm key={app.allowlist.join(",") + String(app.allowlistIsDefault)} app={app} />

      <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>
        Forget this App
      </Button>
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Forget the GitHub App?"
        description="Jarvis deletes its keys and installation list. The App still exists on GitHub: delete it there (Settings → Developer settings → GitHub Apps) to revoke it."
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="danger" busy={forget.isPending} onClick={() => forget.mutate()}>
              Forget App
            </Button>
          </>
        }
      />
    </div>
  );
}

function AllowlistForm({ app }: { app: PublicGithubApp }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [text, setText] = useState(app.allowlist.join(", "));
  const save = useMutation({
    mutationFn: (allowlist: string[] | null) => api.patch("/api/github/app", { allowlist }),
    onSuccess: () => {
      toast("Allowlist saved", "ok");
      qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => toast((e as Error).message, "danger"),
  });
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(parseRepoList(text));
      }}
    >
      <Field
        id="gh-app-allowlist"
        label="Accounts Jarvis accepts"
        hint={
          app.allowlistIsDefault
            ? "Default: the owners of your saved tokens plus the App's owner. Installations on other accounts are ignored."
            : "Installations on other accounts are ignored and flagged."
        }
      >
        <input id="gh-app-allowlist" className={inputCls} value={text} onChange={(e) => setText(e.target.value)} placeholder="nickbolles, momentumbets" />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" busy={save.isPending && save.variables !== null}>
          Save allowlist
        </Button>
        {!app.allowlistIsDefault ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => save.mutate(null)}>
            Use default
          </Button>
        ) : null}
      </div>
    </form>
  );
}
