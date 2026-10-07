"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { relativeTime } from "@/lib/time";
import { useAccess } from "@/components/access";
import { Badge, Button, Card, Empty, ErrorNote, Field, PageHeader, Spinner, inputCls, useNow, useToast } from "@/components/ui";

type Device = { id: string; name: string; platform: string; appVersion?: string; pushEnabled: boolean; createdAt: string; lastSeenAt: string };
type Pairing = { code: string; expiresAt: string; server: string; uri: string; qrSvg: string };
type PushStatus = { configured: boolean; clientConfig: boolean; serviceAccount: boolean; projectId?: string; projectMismatch: boolean; fromEnv: boolean };

/** Settings → Phones: pair the Android app (QR or code), see and revoke phones, set up Firebase push. */
export function PhonesView() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const now = useNow(1000);
  const { isAdmin } = useAccess();
  const devices = useQuery({ queryKey: ["devices"], queryFn: () => api.get<{ devices: Device[] }>("/api/devices"), refetchInterval: 5000 });
  const push = useQuery({ queryKey: ["push-config"], queryFn: () => api.get<PushStatus>("/api/devices/push-config") });

  const [pairing, setPairing] = useState<Pairing>();
  const showCode = useMutation({
    mutationFn: () => api.post<Pairing>("/api/devices/pairing"),
    onSuccess: setPairing,
    onError: (e) => toast((e as Error).message, "danger"),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/api/devices/${encodeURIComponent(id)}`),
    onSuccess: () => {
      toast("Phone signed out", "ok");
      qc.invalidateQueries({ queryKey: ["devices"] });
    },
    onError: (e) => toast((e as Error).message, "danger"),
  });

  const [googleServices, setGoogleServices] = useState("");
  const [serviceAccount, setServiceAccount] = useState("");
  const savePush = useMutation({
    mutationFn: () =>
      api.put<PushStatus>("/api/devices/push-config", {
        ...(googleServices.trim() ? { googleServices: googleServices.trim() } : {}),
        ...(serviceAccount.trim() ? { serviceAccount: serviceAccount.trim() } : {}),
      }),
    onSuccess: () => {
      setGoogleServices("");
      setServiceAccount("");
      toast("Firebase settings saved", "ok");
      qc.invalidateQueries({ queryKey: ["push-config"] });
    },
    onError: (e) => toast((e as Error).message, "danger"),
  });

  const expired = pairing ? new Date(pairing.expiresAt).getTime() < now : false;
  const list = devices.data?.devices ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-5 sm:px-6">
      <PageHeader title="Phones" subtitle="The Jarvis Android app: pair it, see where you're signed in, set up notifications." />

      <Card>
        <h2 className="font-semibold">Pair a phone</h2>
        <p className="mt-1 text-sm text-muted">
          In the Jarvis app, tap <strong>Scan pairing code</strong> and point it at the QR code, or type the server address and code by hand. Codes work once
          and expire after 10 minutes.
        </p>
        {pairing && !expired ? (
          <div className="mt-4 flex flex-wrap items-center gap-5">
            <div
              role="img"
              aria-label={`Pairing QR code for code ${pairing.code}`}
              className="h-48 w-48 shrink-0 rounded-xl bg-white p-2 [&>svg]:h-full [&>svg]:w-full"
              dangerouslySetInnerHTML={{ __html: pairing.qrSvg }}
            />
            <dl className="min-w-0 space-y-2 text-sm">
              <div>
                <dt className="text-muted">Server</dt>
                <dd className="font-mono [overflow-wrap:anywhere]">{pairing.server}</dd>
              </div>
              <div>
                <dt className="text-muted">Code</dt>
                <dd className="font-mono text-2xl font-semibold tracking-widest" data-testid="pairing-code">
                  {pairing.code}
                </dd>
              </div>
              <div className="text-muted" data-dynamic>
                Expires {relativeTime(pairing.expiresAt, now)}
              </div>
            </dl>
          </div>
        ) : null}
        <div className="mt-4">
          <Button variant={pairing && !expired ? "secondary" : "primary"} busy={showCode.isPending} onClick={() => showCode.mutate()}>
            {pairing ? "Show a new code" : "Show pairing code"}
          </Button>
        </div>
      </Card>

      <Card>
        <h2 className="mb-2 font-semibold">Paired phones</h2>
        {devices.isLoading ? <Spinner label="Loading…" /> : null}
        {devices.error ? <ErrorNote error={devices.error} retry={() => devices.refetch()} /> : null}
        {!devices.isLoading && !list.length ? <Empty title="No phones paired yet" /> : null}
        <ul className="divide-y divide-line">
          {list.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="font-medium [overflow-wrap:anywhere]">{d.name}</p>
                <p className="text-sm text-muted" data-dynamic>
                  Last seen {relativeTime(d.lastSeenAt, now)}
                  {d.appVersion ? ` · app ${d.appVersion}` : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={d.pushEnabled ? "ok" : "neutral"}>{d.pushEnabled ? "Notifications on" : "No notifications"}</Badge>
                <Button size="sm" variant="ghost" busy={revoke.isPending && revoke.variables === d.id} onClick={() => revoke.mutate(d.id)}>
                  Sign out<span className="sr-only"> {d.name}</span>
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <h2 className="font-semibold">Phone notifications (Firebase)</h2>
        <p className="mt-1 text-sm text-muted">
          Android delivers notifications to a closed app through Firebase Cloud Messaging. Set it up once (free): create a Firebase project, add an Android app
          with package <code>com.nickbolles.jarvis</code>, download its <code>google-services.json</code>, and create a service-account key under Project
          settings → Service accounts. Paste both below. The app picks the settings up automatically.
        </p>
        <div className="mt-3 flex flex-wrap gap-2 text-sm">
          {push.data ? push.data.configured ? <Badge tone="ok">Configured · {push.data.projectId}</Badge> : <Badge tone="warn">Not configured</Badge> : null}
          {push.data?.projectMismatch ? <Badge tone="danger">The two files are from different Firebase projects</Badge> : null}
          {push.data?.fromEnv ? <Badge>Set by environment</Badge> : null}
        </div>
        {!isAdmin ? <p className="mt-3 text-sm text-muted">Only an admin can change these.</p> : null}
        <form
          hidden={!isAdmin}
          className="mt-4 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            savePush.mutate();
          }}
        >
          <Field id="gs" label="google-services.json" hint={push.data?.clientConfig ? "Saved. Paste again to replace." : undefined}>
            <textarea id="gs" className={`${inputCls} h-24 font-mono text-xs`} value={googleServices} onChange={(e) => setGoogleServices(e.target.value)} />
          </Field>
          <Field
            id="sa"
            label="Service-account key (JSON)"
            hint={push.data?.serviceAccount ? "Saved (encrypted). Paste again to replace." : "Stored encrypted on the Jarvis server; never sent to the phone."}
          >
            <textarea
              id="sa"
              className={`${inputCls} h-24 font-mono text-xs`}
              value={serviceAccount}
              onChange={(e) => setServiceAccount(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Button type="submit" busy={savePush.isPending} disabled={!googleServices.trim() && !serviceAccount.trim()}>
            Save Firebase settings
          </Button>
        </form>
      </Card>
    </div>
  );
}
