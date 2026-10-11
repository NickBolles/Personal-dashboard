"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/client/api";
import { Button, Card, Field, PageHeader, inputCls } from "@/components/ui";

type Preview = {
  revision: string;
  entries: { kind: string; label: string; fields: number; secrets: number; action: "add" | "preserve" | "replace"; environmentOverrides: boolean }[];
};
const endpoint = "/api/settings/configuration";
const maxFileBytes = 128 * 1024;

export function ConfigurationView() {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [file, setFile] = useState("");
  const [preview, setPreview] = useState<Preview>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Configuration operation failed");
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    if (password !== confirmation) {
      setError("Passwords must match before exporting.");
      return;
    }
    await perform(async () => {
      const result = await api.post<{ file: string }>(endpoint, { operation: "export", password, includeSecrets });
      const url = URL.createObjectURL(new Blob([result.file], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "jarvis-configuration.encrypted.json";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setPassword("");
      setConfirmation("");
      setPreview(undefined);
      setMessage("Encrypted configuration downloaded. Keep its password separately; it cannot be recovered.");
    });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-5 sm:px-6">
      <PageHeader title="Configuration transfer" />
      <Link href="/settings" className="text-sm text-accent underline">
        Back to Settings
      </Link>
      <p className="text-sm text-muted">
        Move stored integration settings between Jarvis instances. This is not a backup: no people, sign-ins, conversations, finance records, or deployment
        environment are included.
      </p>
      <Card>
        <Field id="config-password" label="File password" hint="At least 12 characters. Use a unique, strong password; encryption is always required.">
          <input
            id="config-password"
            type="password"
            autoComplete="off"
            maxLength={1024}
            className={inputCls}
            value={password}
            disabled={busy}
            onChange={(e) => {
              setPassword(e.target.value);
              setPreview(undefined);
            }}
          />
        </Field>
      </Card>
      <Card>
        <h2 className="mb-3 font-semibold">Export configuration</h2>
        <div className="space-y-4">
          <Field id="config-confirm" label="Confirm export password">
            <input
              id="config-confirm"
              type="password"
              autoComplete="off"
              maxLength={1024}
              className={inputCls}
              value={confirmation}
              disabled={busy}
              onChange={(e) => setConfirmation(e.target.value)}
            />
          </Field>
          <label className="flex min-h-11 items-start gap-3 text-sm">
            <input type="checkbox" className="mt-1" checked={includeSecrets} disabled={busy} onChange={(e) => setIncludeSecrets(e.target.checked)} />
            <span>Include stored integration secrets (optional). Anyone with this file and password can recover these credentials.</span>
          </label>
          <Button disabled={busy || password.length < 12 || !confirmation} onClick={download}>
            Download encrypted file
          </Button>
        </div>
      </Card>
      <Card>
        <h2 className="mb-3 font-semibold">Import configuration</h2>
        <div className="space-y-4">
          <Field id="config-file" label="Encrypted configuration file" hint="Maximum 128 KiB. Enter the file’s password above, then preview before applying.">
            <input
              id="config-file"
              type="file"
              accept=".json,application/json"
              className={`${inputCls} min-w-0 max-w-full`}
              disabled={busy}
              onChange={(e) => {
                const selected = e.target.files?.[0];
                setFile("");
                setPreview(undefined);
                setError("");
                setMessage("");
                if (!selected) return;
                if (selected.size > maxFileBytes) {
                  setError("The file exceeds 128 KiB.");
                  return;
                }
                void perform(async () => {
                  setFile(await selected.text());
                });
              }}
            />
          </Field>
          <label className="flex min-h-11 items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={replaceExisting}
              disabled={busy}
              onChange={(e) => {
                setReplaceExisting(e.target.checked);
                setPreview(undefined);
              }}
            />
            <span>
              Replace matching existing integrations. Unchecked preserves them. Replacement removes omitted fields and secrets, including credentials not
              included in the file.
            </span>
          </label>
          <p className="text-sm text-muted">
            Added or replaced integrations stay disabled and unverified. Environment overrides still win. Review and test connections before deliberately
            enabling them; import does not start scheduled work.
          </p>
          <Button
            disabled={busy || !file || password.length < 12}
            onClick={() => {
              setPreview(undefined);
              void perform(async () => {
                setPreview(await api.post<Preview>(endpoint, { operation: "preview", file, password, replaceExisting }));
              });
            }}
          >
            Decrypt and preview
          </Button>
          {preview ? (
            <section aria-label="Import preview" className="space-y-3">
              <h3 className="font-semibold">Review changes</h3>
              <p className="text-sm text-muted">Only names and counts are shown, never imported values or secrets.</p>
              <ul className="space-y-2">
                {preview.entries.map((entry) => (
                  <li key={entry.kind} className="rounded-lg border border-line p-3 text-sm">
                    <strong>{entry.label}</strong>: {entry.action} · {entry.fields} settings · {entry.secrets} secrets
                    {entry.environmentOverrides ? <p>Deployment environment overrides apply.</p> : null}
                  </li>
                ))}
              </ul>
              {!preview.entries.length ? <p>No integration entries in this file.</p> : null}
              <Button
                variant="primary"
                disabled={busy || !preview.entries.some((e) => e.action !== "preserve")}
                onClick={() =>
                  void perform(async () => {
                    const result = await api.post<{ applied: number; preserved: number }>(endpoint, {
                      operation: "apply",
                      file,
                      password,
                      replaceExisting,
                      revision: preview.revision,
                    });
                    setMessage(`Applied ${result.applied}; preserved ${result.preserved}. Review Connections before enabling imported integrations.`);
                    setPreview(undefined);
                    setPassword("");
                    setConfirmation("");
                    setFile("");
                  })
                }
              >
                Apply reviewed configuration
              </Button>
            </section>
          ) : null}
        </div>
      </Card>
      {busy ? <p role="status">Processing encrypted configuration…</p> : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
      <Link href="/settings/connections" className="inline-block min-h-11 text-sm text-accent underline">
        Review Connections
      </Link>
    </div>
  );
}
