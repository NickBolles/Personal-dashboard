"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { INTEGRATIONS, getIntegrationDef, type IntegrationKind, type PublicIntegration, type TestResult } from "@/integrations/registry";
import { IntegrationForm, TestResults } from "@/components/integrations/IntegrationForm";
import { PushControls, QuietHours } from "@/components/NotificationSetup";
import { InstallPrompt } from "@/components/InstallPrompt";
import { Badge, Button, Field, cx, inputCls, useToast } from "@/components/ui";
import { CheckIcon } from "@/components/icons";

type Step = { id: string; title: string; optional?: boolean };

const STEPS: Step[] = [
  { id: "welcome", title: "Welcome" },
  ...INTEGRATIONS.map((i) => ({ id: i.kind, title: i.label, optional: !i.recommended })),
  { id: "notifications", title: "Notifications" },
  { id: "install", title: "Install" },
  { id: "finish", title: "Verify & finish" },
];

export function OnboardingWizard({ claimed, initialStep, googleStatus, googleMessage }: { claimed: boolean; initialStep?: string; googleStatus?: string; googleMessage?: string }) {
  if (!claimed) return <ClaimStep />;
  return <Wizard initialStep={initialStep} googleStatus={googleStatus} googleMessage={googleMessage} />;
}

function ClaimStep() {
  const [setupCode, setSetupCode] = useState("");
  const [name, setName] = useState("");
  const [passcode, setPasscode] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  return (
    <main id="main" className="mx-auto max-w-md px-4 py-10">
      <p className="text-sm font-medium text-accent">Jarvis setup</p>
      <h1 className="text-3xl font-semibold tracking-tight">Claim this Jarvis</h1>
      <p className="mt-2 text-muted">
        Enter the one-time setup code printed in the server log (<code>docker compose logs jarvis</code>), then choose a passcode.
      </p>
      <form
        className="card mt-6 space-y-4 p-5"
        onSubmit={async (e) => {
          e.preventDefault();
          if (passcode !== confirm) return setError("Passcodes don’t match");
          setBusy(true);
          setError(undefined);
          try {
            await api.post("/api/auth/setup", { setupCode, name, passcode, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
            window.location.href = "/onboarding?step=welcome";
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <Field id="setup-code" label="Setup code">
          <input id="setup-code" required autoComplete="one-time-code" className={cx(inputCls, "font-mono uppercase")} value={setupCode} onChange={(e) => setSetupCode(e.target.value)} />
        </Field>
        <Field id="owner-name" label="Your name">
          <input id="owner-name" required className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Nick" autoComplete="given-name" />
        </Field>
        <Field id="new-passcode" label="Passcode" hint="At least 6 characters. Used to sign in on new devices.">
          <input id="new-passcode" type="password" required minLength={6} autoComplete="new-password" className={inputCls} value={passcode} onChange={(e) => setPasscode(e.target.value)} />
        </Field>
        <Field id="confirm-passcode" label="Confirm passcode" error={error}>
          <input id="confirm-passcode" type="password" required minLength={6} autoComplete="new-password" className={inputCls} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" className="w-full" busy={busy}>
          Continue
        </Button>
      </form>
    </main>
  );
}

function useIntegrations() {
  return useQuery({ queryKey: ["integrations"], queryFn: () => api.get<{ integrations: PublicIntegration[] }>("/api/integrations") });
}

function Wizard({ initialStep, googleStatus, googleMessage }: { initialStep?: string; googleStatus?: string; googleMessage?: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const startIdx = Math.max(0, STEPS.findIndex((s) => s.id === initialStep));
  const [idx, setIdx] = useState(startIdx);
  const step = STEPS[idx]!;
  const integrations = useIntegrations();
  const status = (k: string) => integrations.data?.integrations.find((i) => i.kind === k);

  useEffect(() => {
    if (googleStatus === "connected") toast("Google connected. Now test the connection.", "ok");
    else if (googleStatus === "error") toast(googleMessage ?? "Google sign-in failed", "danger");
  }, [googleStatus, googleMessage, toast]);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("step", step.id);
    url.searchParams.delete("google");
    url.searchParams.delete("message");
    window.history.replaceState(null, "", url);
    document.getElementById("step-title")?.focus();
  }, [step.id]);

  const next = () => setIdx((i) => Math.min(i + 1, STEPS.length - 1));
  const back = () => setIdx((i) => Math.max(i - 1, 0));

  const finish = useMutation({
    mutationFn: () => api.put("/api/settings", { onboarding: { completedAt: new Date().toISOString() } }),
    onSuccess: () => router.push("/home"),
  });

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 lg:flex lg:gap-8">
      <nav aria-label="Setup steps" className="mb-4 lg:mb-0 lg:w-56 lg:shrink-0">
        <p className="mb-2 text-sm font-medium text-accent">Jarvis setup</p>
        <ol className="flex gap-1 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible">
          {STEPS.map((s, i) => {
            const st = status(s.id);
            const verified = st?.lastTest?.ok;
            return (
              <li key={s.id} className="shrink-0">
                <button
                  type="button"
                  onClick={() => setIdx(i)}
                  aria-current={i === idx ? "step" : undefined}
                  className={cx(
                    "flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-sm whitespace-nowrap",
                    i === idx ? "bg-accent-soft font-semibold text-accent" : "text-muted hover:bg-surface-2",
                  )}
                >
                  <span aria-hidden="true" className={cx("flex h-6 w-6 items-center justify-center rounded-full border text-xs", verified ? "border-ok bg-ok-soft text-ok" : "border-line-strong")}>
                    {verified ? <CheckIcon className="h-3.5 w-3.5" /> : i + 1}
                  </span>
                  {s.title}
                  {verified ? <span className="sr-only">(verified)</span> : null}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      <main id="main" className="min-w-0 flex-1">
        <h1 id="step-title" tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">
          {step.title}
          {step.optional ? <span className="ml-2 align-middle text-sm font-normal text-muted">(optional)</span> : null}
        </h1>
        <div className="mt-4">
          {step.id === "welcome" ? <Welcome /> : null}
          {getIntegrationDef(step.id) ? <IntegrationStep kind={step.id as IntegrationKind} onVerified={() => toast(`${step.title} connected`, "ok")} /> : null}
          {step.id === "notifications" ? (
            <div className="card space-y-6 p-5">
              <p className="text-muted">The Alerts inbox is the source of truth; push is how it reaches your phone. Enable push on each device you use.</p>
              <PushControls />
              <QuietHours />
            </div>
          ) : null}
          {step.id === "install" ? (
            <div className="card p-5">
              <p className="mb-4 text-muted">Install Jarvis to your home screen for a full-screen app, faster launch, offline access, and reliable notifications.</p>
              <InstallPrompt />
            </div>
          ) : null}
          {step.id === "finish" ? <Finish integrations={integrations.data?.integrations ?? []} onRefresh={() => integrations.refetch()} /> : null}
        </div>

        <div className="mt-6 flex flex-wrap justify-between gap-2">
          <Button variant="ghost" onClick={back} disabled={idx === 0}>
            Back
          </Button>
          {step.id === "finish" ? (
            <Button variant="primary" busy={finish.isPending} onClick={() => finish.mutate()}>
              Open Jarvis
            </Button>
          ) : (
            <div className="flex gap-2">
              {getIntegrationDef(step.id) && !status(step.id)?.lastTest?.ok ? (
                <Button variant="ghost" onClick={next}>
                  Skip for now
                </Button>
              ) : null}
              <Button variant="primary" onClick={next}>
                Continue
              </Button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function Welcome() {
  return (
    <div className="card space-y-4 p-5">
      <p>
        Jarvis is your command center for <strong>Hermes</strong> and the systems around it. It answers one question: <em>what needs my attention, and what should I do next?</em>
      </p>
      <ul className="grid gap-2 sm:grid-cols-2">
        {INTEGRATIONS.map((i) => (
          <li key={i.kind} className="rounded-xl border border-line p-3">
            <p className="font-medium">
              {i.label} {!i.recommended ? <span className="text-xs font-normal text-muted">optional</span> : null}
            </p>
            <p className="text-sm text-muted">{i.tagline}</p>
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted">
        Each step saves the connection on the server (secrets are encrypted and never sent back to the browser) and runs a live test. You can skip anything and finish later in Settings → Connections.
      </p>
    </div>
  );
}

function IntegrationStep({ kind, onVerified }: { kind: IntegrationKind; onVerified: () => void }) {
  const def = getIntegrationDef(kind)!;
  return (
    <div className="card space-y-4 p-5">
      <p className="text-muted">{def.tagline}</p>
      <ul className="flex flex-wrap gap-2">
        {def.uses.map((u) => (
          <li key={u}>
            <Badge>{u}</Badge>
          </li>
        ))}
      </ul>
      <IntegrationForm kind={kind} onVerified={onVerified} compact />
    </div>
  );
}

function Finish({ integrations, onRefresh }: { integrations: PublicIntegration[]; onRefresh: () => void }) {
  const qc = useQueryClient();
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Record<string, TestResult>>({});
  const runAll = async () => {
    setRunning(true);
    const enabled = integrations.filter((i) => i.enabled);
    const out: Record<string, TestResult> = {};
    for (const i of enabled) {
      try {
        out[i.kind] = await api.post<TestResult>(`/api/integrations/${i.kind}/test`);
      } catch (err) {
        out[i.kind] = { ok: false, checkedAt: new Date().toISOString(), summary: (err as Error).message, checks: [{ name: "Test", ok: false, detail: (err as Error).message }] };
      }
      setResults({ ...out });
    }
    await api.post("/api/worker/tick").catch(() => undefined);
    qc.invalidateQueries({ queryKey: ["home"] });
    onRefresh();
    setRunning(false);
  };
  return (
    <div className="card space-y-4 p-5">
      <p className="text-muted">Re-run every enabled connection test, then do one background refresh so Home has live data when you open it.</p>
      <Button onClick={runAll} busy={running}>
        Re-test all connections
      </Button>
      <ul className="space-y-3">
        {INTEGRATIONS.map((d) => {
          const i = integrations.find((x) => x.kind === d.kind);
          const r = results[d.kind] ?? i?.lastTest;
          return (
            <li key={d.kind} className="rounded-xl border border-line p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{d.label}</span>
                {!i?.enabled ? <Badge>Skipped</Badge> : r?.ok ? <Badge tone="ok">Verified</Badge> : r ? <Badge tone="danger">Failing</Badge> : <Badge tone="warn">Not tested</Badge>}
              </div>
              {i?.enabled && r && !r.ok ? (
                <div className="mt-2">
                  <TestResults result={r} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
