"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { BACKEND_LABELS, CLAUDE_MODELS, EFFORTS, type AssistantStatus } from "@/lib/assistant";
import { Badge, Button, Card, Field, inputCls, useToast } from "@/components/ui";

/** Settings → Assistant: Hermes or Claude for new conversations; Claude model, effort and key (admin). */
export function AssistantSettings() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["assistant"], queryFn: () => api.get<AssistantStatus>("/api/assistant") });
  const [form, setForm] = useState({ defaultBackend: "hermes", model: "", effort: "low", apiKey: "" });
  useEffect(() => {
    if (q.data) setForm((f) => ({ ...f, defaultBackend: q.data.defaultBackend, model: q.data.claude.model, effort: q.data.claude.effort }));
  }, [q.data]);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put<AssistantStatus>("/api/assistant", body),
    onSuccess: () => {
      toast("Assistant settings saved", "ok");
      setForm((f) => ({ ...f, apiKey: "" }));
      qc.invalidateQueries({ queryKey: ["assistant"] });
    },
    onError: (e) => toast((e as Error).message, "danger"),
  });
  const s = q.data;
  if (!s) return null;
  return (
    <Card>
      <h2 className="font-semibold">Assistant</h2>
      <p className="mt-1 text-sm text-muted">
        Hermes can act (tools, approvals) but can be slow. Claude answers directly and fast, with any Jarvis context you attach, but can’t act. Everyone can
        pick per conversation.
      </p>
      <ul className="mt-2 flex flex-wrap gap-2">
        {s.backends.map((b) => (
          <li key={b.id}>
            <Badge tone={b.available ? "ok" : "warn"}>
              {b.label}: {b.available ? "ready" : b.reason}
            </Badge>
          </li>
        ))}
      </ul>
      <form
        className="mt-4 grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({
            defaultBackend: form.defaultBackend,
            model: form.model,
            effort: form.effort,
            ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
          });
        }}
      >
        <Field id="as-default" label="New conversations go to">
          <select id="as-default" className={inputCls} value={form.defaultBackend} onChange={(e) => setForm({ ...form, defaultBackend: e.target.value })}>
            {s.backends.map((b) => (
              <option key={b.id} value={b.id}>
                {BACKEND_LABELS[b.id].label}
              </option>
            ))}
          </select>
        </Field>
        <Field id="as-model" label="Claude model">
          <select id="as-model" className={inputCls} value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}>
            {CLAUDE_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>
        <Field id="as-effort" label="Claude effort" hint="Low is quickest and fine for chat; higher thinks longer.">
          <select id="as-effort" className={inputCls} value={form.effort} onChange={(e) => setForm({ ...form, effort: e.target.value })}>
            {EFFORTS.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </Field>
        <Field
          id="as-key"
          label="Anthropic API key"
          hint={
            s.claude.keySet
              ? "Saved (encrypted). Paste a new one to replace it."
              : s.claude.keyFromEnv
                ? "Using ANTHROPIC_API_KEY from the server environment."
                : "Stored encrypted on the server; never sent back to the browser."
          }
        >
          <input
            id="as-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            className={inputCls}
            value={form.apiKey}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
          />
        </Field>
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <Button type="submit" variant="primary" busy={save.isPending}>
            Save
          </Button>
          {s.claude.keySet ? (
            <Button type="button" variant="ghost" onClick={() => save.mutate({ apiKey: null })}>
              Remove saved key
            </Button>
          ) : null}
        </div>
      </form>
    </Card>
  );
}
