"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { Badge, Button, Card, Dialog, Field, inputCls, useToast } from "@/components/ui";
import type { CaptureTokenView } from "@/lib/ai";

/**
 * Settings → Phones → Capture tokens: capture-only bearer tokens for HTTP
 * Shortcuts / Tasker. Shown once at creation; revocable; rate-limited.
 */
export function CaptureTokens() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["capture-tokens"], queryFn: () => api.get<{ tokens: CaptureTokenView[] }>("/api/devices/capture-tokens") });
  const [label, setLabel] = useState("");
  const [mode, setMode] = useState<"inherit" | "triage_only" | "off">("inherit");
  const [shown, setShown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ token: string }>("/api/devices/capture-tokens", { label: label.trim(), investigateMode: mode });
      setShown(r.token);
      setLabel("");
      qc.invalidateQueries({ queryKey: ["capture-tokens"] });
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (id: string) => {
    await api.del(`/api/devices/capture-tokens/${encodeURIComponent(id)}`).catch((e) => toast((e as Error).message, "danger"));
    qc.invalidateQueries({ queryKey: ["capture-tokens"] });
  };
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return (
    <Card>
      <h2 className="font-semibold">Capture tokens</h2>
      <p className="mb-2 text-[13px] text-muted">
        For HTTP Shortcuts or Tasker: a token that can only add captures to your Inbox (30 per hour, 300 per day, expires in a year). It can&apos;t read
        anything else.
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (label.trim()) void create();
        }}
      >
        <div className="min-w-0 flex-1 basis-48">
          <Field id="ctk-label" label="Label">
            <input
              id="ctk-label"
              className={inputCls}
              maxLength={60}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Pixel HTTP Shortcuts"
            />
          </Field>
        </div>
        <Field id="ctk-mode" label="AI follow-up">
          <select id="ctk-mode" className={inputCls} value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="inherit">Same as Settings → AI</option>
            <option value="triage_only">Triage only</option>
            <option value="off">No AI</option>
          </select>
        </Field>
        <Button type="submit" busy={busy} disabled={!label.trim()}>
          Create token
        </Button>
      </form>
      <ul className="wk-rows mt-2">
        {(q.data?.tokens ?? []).map((t) => (
          <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[13px]">
            <span className="min-w-0">
              <strong>{t.label}</strong> <span className="font-mono text-muted">jcap_{t.prefixHint}…</span>
              <span className="block text-xs text-muted" data-dynamic>
                {t.useCount} captures · last used {t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleDateString() : "never"} · expires{" "}
                {new Date(t.expiresAt).toLocaleDateString()}
              </span>
            </span>
            {t.revokedAt ? (
              <Badge>Revoked</Badge>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => void revoke(t.id)} aria-label={`Revoke ${t.label}`}>
                Revoke
              </Button>
            )}
          </li>
        ))}
      </ul>
      {shown ? (
        <Dialog
          open
          onClose={() => setShown(null)}
          title="Copy your capture token"
          description="Shown once. Jarvis keeps only a hash."
          footer={
            <Button variant="primary" onClick={() => setShown(null)}>
              Done
            </Button>
          }
        >
          <div className="space-y-2 text-[13px]">
            <code className="block rounded-md bg-surface-2 p-2 font-mono text-xs break-all" data-testid="capture-token-value">
              {shown}
            </code>
            <Button size="sm" onClick={() => void navigator.clipboard?.writeText(shown).then(() => toast("Copied", "ok"))}>
              Copy token
            </Button>
            <p className="font-semibold">HTTP Shortcuts recipe</p>
            <pre className="ai-pre whitespace-pre-wrap">{`POST ${origin}/api/capture
Authorization: Bearer <token>
Content-Type: application/json

{"text": "{clipboard}", "channel": "shortcut", "clientCaptureId": "{uuid}"}`}</pre>
          </div>
        </Dialog>
      ) : null}
    </Card>
  );
}
