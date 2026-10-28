"use client";

import { useState } from "react";
import { api } from "@/lib/client/api";
import { useAccess } from "@/components/access";
import { Button, Field, inputCls } from "@/components/ui";
import { useWorkMutation } from "@/components/work/common";
import {
  CONTEXT_SOURCES,
  CONTEXT_SOURCE_LABELS,
  DEFAULT_AREA_SETTINGS,
  SETTLE_POLICIES,
  SETTLE_POLICY_LABELS,
  type AreaSettings,
  type WorkItem,
} from "@/lib/work";
import { ModelCombobox } from "./ModelPicker";

/**
 * Per-area settings (phase 4): agent mode (sent to Hermes as run
 * instructions), the default assistant and model, the repo the `#` picker
 * searches, context attached to every message, and the settle policy.
 * The validation default stays in the area's Details.
 */
export function AreaSettingsCard({ area }: { area: WorkItem }) {
  const canChat = useAccess().can("hermes.chat");
  const [f, setF] = useState<AreaSettings>(area.settings ?? DEFAULT_AREA_SETTINGS);
  const [open, setOpen] = useState(false);
  const save = useWorkMutation(() => api.patch(`/api/work/items/${encodeURIComponent(area.id)}`, { settings: f }), { ok: "Area settings saved" });
  const set = <K extends keyof AreaSettings>(k: K, v: AreaSettings[K]) => setF((x) => ({ ...x, [k]: v }));
  const s = area.settings ?? DEFAULT_AREA_SETTINGS;
  const summary = [
    s.agentMode ? `Mode ${s.agentMode}` : null,
    s.defaultModel ? `Model ${s.defaultModel}` : null,
    s.defaultRepo,
    SETTLE_POLICY_LABELS[s.settlePolicy].split(" ")[0] + " settle",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <section className="card" aria-label="Area settings">
      <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} data-testid="area-settings">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 dense:min-h-9">
          <span className="text-[13.5px] font-semibold">Area settings</span>
          <span className="min-w-0 truncate text-xs text-muted">{summary}</span>
        </summary>
        <form
          className="space-y-3 border-t border-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(undefined);
          }}
        >
          {canChat ? (
            <fieldset className="space-y-3">
              <legend className="eyebrow mb-1">Agent</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  id="as-mode"
                  label="Agent mode"
                  hint="A Hermes profile, e.g. momentumchief. With a route in Settings → Agents, new chats and AI actions here run on that profile; otherwise it's sent as a hint."
                >
                  <input
                    id="as-mode"
                    className={inputCls}
                    value={f.agentMode ?? ""}
                    onChange={(e) => set("agentMode", e.target.value || null)}
                    maxLength={80}
                  />
                </Field>
                <Field id="as-backend" label="New conversations use">
                  <select
                    id="as-backend"
                    className={inputCls}
                    value={f.defaultBackend ?? ""}
                    onChange={(e) => set("defaultBackend", (e.target.value || null) as AreaSettings["defaultBackend"])}
                  >
                    <option value="">Household default</option>
                    <option value="hermes">Hermes</option>
                    <option value="claude">Claude</option>
                  </select>
                </Field>
              </div>
              <Field id="as-instructions" label="Instructions (optional)">
                <textarea
                  id="as-instructions"
                  className={`${inputCls} min-h-16`}
                  value={f.instructions ?? ""}
                  onChange={(e) => set("instructions", e.target.value || null)}
                  maxLength={2000}
                />
              </Field>
              <ModelCombobox
                backend={f.defaultBackend ?? "hermes"}
                label="Default model"
                defaultHint="assistant default"
                value={{ model: f.defaultModel ?? undefined, provider: f.defaultProvider ?? undefined }}
                onChange={(m) => setF((x) => ({ ...x, defaultModel: m.model ?? null, defaultProvider: m.provider ?? null }))}
              />
              <fieldset>
                <legend className="mb-1 text-sm font-medium">Attach to every message</legend>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {CONTEXT_SOURCES.map((c) => (
                    <label key={c} className="flex min-h-11 items-center gap-2 text-[13.5px] dense:min-h-8">
                      <input
                        type="checkbox"
                        checked={f.contextSources.includes(c)}
                        onChange={(e) => set("contextSources", e.target.checked ? [...f.contextSources, c] : f.contextSources.filter((x) => x !== c))}
                      />
                      {CONTEXT_SOURCE_LABELS[c]}
                    </label>
                  ))}
                </div>
              </fieldset>
            </fieldset>
          ) : null}
          <Field id="as-repo" label="Default repo" hint="owner/repo — the # picker searches it and PR links default to it.">
            <input
              id="as-repo"
              className={inputCls}
              value={f.defaultRepo ?? ""}
              onChange={(e) => set("defaultRepo", e.target.value.trim() || null)}
              placeholder="owner/repo"
              pattern="[A-Za-z0-9_.\-]+/[A-Za-z0-9_.\-]+"
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
            <Field
              id="as-settle"
              label="Settle policy"
              hint="Signals: PR merged, validations pass, no activity for the quiet period. Automatic settling is always undoable."
            >
              <select
                id="as-settle"
                className={inputCls}
                value={f.settlePolicy}
                onChange={(e) => set("settlePolicy", e.target.value as AreaSettings["settlePolicy"])}
              >
                {SETTLE_POLICIES.map((p) => (
                  <option key={p} value={p}>
                    {SETTLE_POLICY_LABELS[p]}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="as-quiet" label="Quiet days">
              <input
                id="as-quiet"
                type="number"
                inputMode="numeric"
                min={1}
                max={90}
                className={inputCls}
                value={f.quietDays}
                onChange={(e) => set("quietDays", Math.max(1, Math.min(90, Number(e.target.value) || 1)))}
              />
            </Field>
          </div>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" size="sm" busy={save.isPending}>
              Save area settings
            </Button>
          </div>
        </form>
      </details>
    </section>
  );
}
