"use client";

import { useState } from "react";
import Link from "next/link";
import { effectiveAutonomy } from "@/lib/away";
import { Segmented } from "@/components/ui/kit";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { useAccess } from "@/components/access";
import { Button, Dialog, Field, inputCls } from "@/components/ui";
import { TAG_COLORS, TAG_COLOR_LABELS, type TagColor } from "@/lib/item-tags";
import { useWorkMutation } from "@/components/work/common";
import {
  AI_POLICIES,
  CONTEXT_SOURCES,
  CONTEXT_SOURCE_LABELS,
  DEFAULT_AREA_SETTINGS,
  SETTLE_POLICIES,
  SETTLE_POLICY_LABELS,
  type AreaSettings,
  type WorkItem,
} from "@/lib/work";
import { ModelCombobox } from "./ModelPicker";

const AI_POLICY_LABELS: Record<AreaSettings["aiPolicy"], string> = {
  allowed: "Allowed",
  triage_only: "Triage only",
  excluded: "Excluded (AI-free)",
};

/**
 * A3: per-area settings, opened from the area header's ⋯ › Area settings…
 * (no always-visible accordion). Agent (coordinator) mode, default assistant
 * and model, the repo the `#` picker searches, context attached to every
 * message, colour, AI policy and the settle policy. Saved with the existing
 * item PATCH (partial settings merge).
 */
export function AreaSettingsDialog({ area, open, onClose }: { area: WorkItem; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const canChat = useAccess().can("hermes.chat");
  const [f, setF] = useState<AreaSettings>({ ...DEFAULT_AREA_SETTINGS, ...(area.settings ?? {}) });
  const save = useWorkMutation(() => api.patch(`/api/work/items/${encodeURIComponent(area.id)}`, { settings: f }), {
    ok: "Area settings saved",
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["agent-schedules"] });
    },
  });
  const set = <K extends keyof AreaSettings>(k: K, v: AreaSettings[K]) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`${area.title} settings`}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="area-settings-form" variant="primary" busy={save.isPending}>
            Save area settings
          </Button>
        </>
      }
    >
      <div data-testid="area-settings">
        <form
          id="area-settings-form"
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(undefined, { onSuccess: onClose });
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="as-color" label="Colour">
              <select id="as-color" className={inputCls} value={f.color ?? ""} onChange={(e) => set("color", (e.target.value || null) as TagColor | null)}>
                <option value="">None</option>
                {TAG_COLORS.map((c) => (
                  <option key={c} value={c}>
                    {TAG_COLOR_LABELS[c]}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="as-ai" label="AI actions" hint="Excluded keeps this area and its subtree out of AI actions, including Finance.">
              <select id="as-ai" className={inputCls} value={f.aiPolicy} onChange={(e) => set("aiPolicy", e.target.value as AreaSettings["aiPolicy"])}>
                {AI_POLICIES.map((p) => (
                  <option key={p} value={p}>
                    {AI_POLICY_LABELS[p]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <AreaAutonomy area={{ ...area, settings: f }} value={f.autonomy} onChange={(value) => set("autonomy", value)} />
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
        </form>
      </div>
    </Dialog>
  );
}

export function AreaAutonomy({
  area,
  value,
  onChange,
}: {
  area: Pick<WorkItem, "title" | "settings" | "id">;
  value: AreaSettings["autonomy"];
  onChange: (value: AreaSettings["autonomy"]) => void;
}) {
  const off = effectiveAutonomy(area) === "off";
  return (
    <div className="min-w-0 space-y-1 [&_.k-seg]:flex-wrap [&_button]:min-h-11 sm:[&_button]:min-h-10 dense:[&_button]:min-h-6">
      {off ? (
        <p className="text-sm text-muted">AI off for this area</p>
      ) : (
        <>
          <p className="text-sm font-medium">Autonomy</p>
          <Segmented
            label="Autonomy"
            value={value}
            onChange={onChange}
            options={[
              { value: "propose", label: "Propose only" },
              { value: "low_risk", label: "Act on low-risk" },
            ]}
          />
          <p className="text-xs text-muted">
            {value === "propose"
              ? "Scheduled runs only suggest; every change becomes a Needs-you decision."
              : "Jarvis may add notes and threads, update next actions and file to Inbox, with Undo. Everything else asks you. Never settles, merges, deploys, spends or sends."}
          </p>
          {area.settings?.aiPolicy === "triage_only" ? <p className="text-xs text-muted">Triage-only policy limits scheduled runs to proposals.</p> : null}
        </>
      )}
      <Link
        href={`/settings/agents?area=${encodeURIComponent(area.id)}#schedules`}
        className="inline-flex min-h-11 items-center text-xs text-accent hover:underline sm:min-h-10 dense:min-h-6"
      >
        Scheduled jobs
      </Link>
    </div>
  );
}
