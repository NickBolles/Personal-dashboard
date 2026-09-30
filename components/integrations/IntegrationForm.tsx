"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { getIntegrationDef, isFieldVisible, type FieldDef, type IntegrationKind, type PublicIntegration, type TestResult } from "@/integrations/registry";
import { Badge, Button, Field, Spinner, cx, inputCls, useToast } from "@/components/ui";
import { CheckIcon } from "@/components/icons";

type Preset = { config: Record<string, string>; secrets: Record<string, string> };

export function usePresets() {
  return useQuery({
    queryKey: ["integrations", "demo"],
    queryFn: () => api.get<{ presets: Partial<Record<IntegrationKind, Preset>> | null }>("/api/integrations/demo"),
    staleTime: Infinity,
  });
}

export function TestResults({ result }: { result?: TestResult }) {
  if (!result) return null;
  return (
    <div role="status" className={cx("rounded-xl border p-3 text-sm", result.ok ? "border-ok bg-ok-soft" : "border-danger bg-danger-soft")}>
      <p className={cx("font-semibold", result.ok ? "text-ok" : "text-danger")}>{result.ok ? "Connection verified" : "Connection failed"}</p>
      <ul className="mt-2 space-y-1">
        {result.checks.map((c) => (
          <li key={c.name} className="flex items-start gap-2">
            <span aria-hidden="true" className={c.ok ? "text-ok" : "text-danger"}>
              {c.ok ? <CheckIcon className="h-4 w-4" /> : "✕"}
            </span>
            <span>
              <span className="font-medium">{c.name}</span>
              <span className="sr-only">{c.ok ? " passed" : " failed"}</span>
              {c.detail ? <span className="text-muted"> — {c.detail}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted">Checked {new Date(result.checkedAt).toLocaleString()}</p>
    </div>
  );
}

/**
 * Shared connect/edit form for one integration (used by onboarding and
 * Settings → Connections). Secrets are write-only: the browser only learns
 * whether one is set, never its value.
 */
export function IntegrationForm({ kind, onVerified, compact }: { kind: IntegrationKind; onVerified?: () => void; compact?: boolean }) {
  const def = getIntegrationDef(kind)!;
  const qc = useQueryClient();
  const { toast } = useToast();
  const presets = usePresets();
  const q = useQuery({ queryKey: ["integration", kind], queryFn: () => api.get<PublicIntegration>(`/api/integrations/${kind}`) });
  const [values, setValues] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [clear, setClear] = useState<Record<string, boolean>>({});
  const [result, setResult] = useState<TestResult>();
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    if (q.data) {
      setValues(Object.fromEntries(Object.entries(q.data.config).map(([k, v]) => [k, String(v ?? "")])));
      setResult(q.data.lastTest);
    }
  }, [q.data]);

  const visible = useMemo(() => def.fields.filter((f) => isFieldVisible(f, values)), [def.fields, values]);

  const save = useMutation({
    mutationFn: async (opts: { enabled?: boolean; test: boolean }) => {
      const config = Object.fromEntries(
        def.fields.filter((f) => f.type !== "secret" && !q.data?.envManaged.includes(f.key)).map((f) => [f.key, values[f.key] ?? ""]),
      );
      const sec: Record<string, string | null> = {};
      for (const f of def.fields.filter((x) => x.type === "secret")) {
        if (clear[f.key]) sec[f.key] = null;
        else if (secrets[f.key]) sec[f.key] = secrets[f.key]!;
      }
      await api.put(`/api/integrations/${kind}`, { enabled: opts.enabled ?? true, config, secrets: sec });
      setSecrets({});
      setClear({});
      if (!opts.test) return undefined;
      return api.post<TestResult>(`/api/integrations/${kind}/test`);
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["integration", kind] });
      qc.invalidateQueries({ queryKey: ["integrations"] });
      qc.invalidateQueries({ queryKey: ["home"] });
      if (r) {
        setResult(r);
        if (r.ok) onVerified?.();
      } else toast("Saved", "ok");
    },
    onError: (e) => toast((e as Error).message, "danger"),
  });

  const applyPreset = () => {
    const p = presets.data?.presets?.[kind];
    if (!p) return;
    setValues((v) => ({ ...v, ...p.config }));
    setSecrets(p.secrets);
    toast("Demo values filled in. Save & test to use the mock server.", "accent");
  };

  if (q.isLoading) return <Spinner label="Loading…" />;
  const pub = q.data;

  const renderField = (f: FieldDef) => {
    const id = `${kind}-${f.key}`;
    const env = pub?.envManaged.includes(f.key);
    const discovered = result?.discovered?.find((d) => d.field === f.key);
    const hint = (
      <>
        {env ? <span className="font-medium">Set by environment ({f.env}). </span> : null}
        {f.help}
      </>
    );
    if (f.type === "secret") {
      const s = pub?.secrets[f.key];
      return (
        <Field key={f.key} id={id} label={f.label} hint={hint}>
          <input
            id={id}
            type="password"
            autoComplete="off"
            disabled={env}
            className={inputCls}
            placeholder={s?.set ? "•••••••• saved — leave blank to keep" : "Not set"}
            value={secrets[f.key] ?? ""}
            onChange={(e) => setSecrets((x) => ({ ...x, [f.key]: e.target.value }))}
          />
          {s?.set && !env ? (
            <label className="mt-1 flex min-h-11 items-center gap-2 text-xs text-muted">
              <input
                type="checkbox"
                className="h-5 w-5"
                checked={Boolean(clear[f.key])}
                onChange={(e) => setClear((c) => ({ ...c, [f.key]: e.target.checked }))}
              />
              Remove saved value
            </label>
          ) : null}
        </Field>
      );
    }
    if (f.type === "select" || discovered) {
      const options = discovered?.options ?? f.options ?? [];
      return (
        <Field key={f.key} id={id} label={f.label} hint={hint}>
          <select
            id={id}
            disabled={env}
            className={inputCls}
            value={values[f.key] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
          >
            {f.type !== "select" ? <option value="">{values[f.key] ? `Keep: ${values[f.key]}` : "Choose…"}</option> : null}
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
      );
    }
    if (f.type === "textarea") {
      return (
        <Field key={f.key} id={id} label={f.label} hint={hint}>
          <textarea
            id={id}
            rows={f.key === "prompt" ? 3 : 5}
            disabled={env}
            className={cx(inputCls, "font-mono text-sm")}
            value={values[f.key] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
          />
        </Field>
      );
    }
    return (
      <Field key={f.key} id={id} label={f.label} hint={hint}>
        <input
          id={id}
          type={f.type === "time" ? "time" : f.type === "url" ? "url" : "text"}
          inputMode={f.type === "url" ? "url" : undefined}
          disabled={env}
          required={f.required}
          className={inputCls}
          placeholder={f.placeholder}
          value={values[f.key] ?? ""}
          onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
        />
      </Field>
    );
  };

  const basic = visible.filter((f) => !f.advanced);
  const advanced = visible.filter((f) => f.advanced);

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ test: true });
      }}
    >
      {!compact ? (
        <div className="flex flex-wrap items-center gap-2">
          {pub?.enabled ? <Badge tone="accent">Enabled</Badge> : <Badge>Not enabled</Badge>}
          {pub?.lastTest ? <Badge tone={pub.lastTest.ok ? "ok" : "danger"}>{pub.lastTest.ok ? "Verified" : "Last test failed"}</Badge> : null}
          {def.docs ? (
            <a href={def.docs} target="_blank" rel="noreferrer noopener" className="text-sm underline">
              Docs<span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : null}
        </div>
      ) : null}
      {presets.data?.presets?.[kind] ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed border-line-strong p-3 text-sm">
          <span>Trying things out? Use the bundled demo server.</span>
          <Button type="button" size="sm" onClick={applyPreset}>
            Use demo values
          </Button>
        </div>
      ) : null}
      {basic.map(renderField)}
      {kind === "todos" && values.provider === "google_tasks" ? (
        <GoogleConnect connected={Boolean(pub?.secrets.refreshToken?.set)} onBeforeConnect={() => save.mutateAsync({ test: false })} />
      ) : null}
      {kind === "skylight" ? <SkylightSignIn onDone={() => qc.invalidateQueries({ queryKey: ["integration", kind] })} /> : null}
      {advanced.length ? (
        <div>
          <button type="button" className="min-h-11 text-sm underline" aria-expanded={showAdvanced} onClick={() => setShowAdvanced((s) => !s)}>
            {showAdvanced ? "Hide" : "Show"} advanced settings
          </button>
          {showAdvanced ? <div className="mt-2 space-y-4">{advanced.map(renderField)}</div> : null}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" busy={save.isPending && save.variables?.test}>
          Save & test connection
        </Button>
        <Button type="button" busy={save.isPending && !save.variables?.test} onClick={() => save.mutate({ test: false })}>
          Save
        </Button>
        {pub?.enabled ? (
          <Button type="button" variant="ghost" onClick={() => save.mutate({ enabled: false, test: false })}>
            Disable
          </Button>
        ) : null}
      </div>
      <TestResults result={result} />
    </form>
  );
}

function GoogleConnect({ connected, onBeforeConnect }: { connected: boolean; onBeforeConnect: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="rounded-xl border border-line bg-surface-2 p-3 text-sm">
      <p className="font-medium">{connected ? "Google account connected" : "Connect your Google account"}</p>
      <p className="mt-1 text-muted">
        Saves the client ID/secret above, then opens Google to grant Tasks access. Jarvis stores only the refresh token, encrypted.
      </p>
      <Button
        type="button"
        size="sm"
        className="mt-2"
        busy={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onBeforeConnect();
            window.location.href = "/api/integrations/todos/oauth/start";
          } catch {
            setBusy(false);
          }
        }}
      >
        {connected ? "Reconnect Google" : "Connect Google"}
      </Button>
    </div>
  );
}

function SkylightSignIn({ onDone }: { onDone: () => void }) {
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const m = useMutation({
    mutationFn: () => api.post("/api/integrations/skylight/login", { email, password }),
    onSuccess: () => {
      setPassword("");
      toast("Signed in to Skylight. Now test the connection.", "ok");
      onDone();
    },
    onError: (e) => toast((e as Error).message, "danger"),
  });
  return (
    <fieldset className="space-y-3 rounded-xl border border-line bg-surface-2 p-3">
      <legend className="px-1 text-sm font-medium">Sign in to Skylight</legend>
      <p className="text-xs text-muted">
        Used once to obtain a refresh token; your password is not stored. If Skylight asks for 2FA, use `skycli auth login` and paste the refresh token instead.
      </p>
      <Field id="sk-email" label="Email">
        <input id="sk-email" type="email" autoComplete="username" className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field id="sk-pass" label="Password">
        <input
          id="sk-pass"
          type="password"
          autoComplete="current-password"
          className={inputCls}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      <Button type="button" size="sm" busy={m.isPending} disabled={!email || !password} onClick={() => m.mutate()}>
        Sign in
      </Button>
    </fieldset>
  );
}
