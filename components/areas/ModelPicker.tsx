"use client";

import { useId, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { Button, Dialog, cx, inputCls, Spinner } from "@/components/ui";
import type { AssistantBackend, ModelOption, ModelsResponse } from "@/lib/assistant";

export function useModels(backend: AssistantBackend, enabled = true) {
  return useQuery({
    queryKey: ["assistant", "models", backend],
    queryFn: () => api.get<ModelsResponse>(`/api/assistant/models?backend=${backend}`),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export type ModelChoice = { model?: string; provider?: string };

/**
 * Searchable model list (WAI-ARIA combobox + listbox) populated from the
 * backend's real list: Hermes /v1/models (+ provider models) or the Claude
 * list. The first row is always "Default" (no override).
 */
export function ModelCombobox({
  backend,
  value,
  onChange,
  label = "Model",
  defaultHint,
  autoFocus,
}: {
  backend: AssistantBackend;
  value: ModelChoice;
  onChange: (v: ModelChoice) => void;
  label?: string;
  /** what "Default" means here (e.g. the area's default) */
  defaultHint?: string;
  autoFocus?: boolean;
}) {
  const q = useModels(backend);
  const id = useId();
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState(0);
  const options = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const list: (ModelOption & { key: string })[] = [
      { key: "default", id: "", label: `Default${defaultHint ? ` (${defaultHint})` : q.data?.defaultModel ? ` (${q.data.defaultModel})` : ""}` },
      ...(q.data?.models ?? []).map((m) => ({ ...m, key: `${m.provider ?? ""}|${m.id}` })),
    ];
    // A saved model the backend no longer lists stays visible (and selectable).
    if (value.model && !list.some((m) => m.id === value.model))
      list.push({ key: `saved|${value.model}`, id: value.model, label: `${value.model} (saved)`, provider: value.provider });
    return list.filter((m) => !needle || `${m.label} ${m.id} ${m.provider ?? ""}`.toLowerCase().includes(needle));
  }, [q.data, filter, value.model, value.provider, defaultHint]);
  const pick = (m: ModelOption) => onChange(m.id ? { model: m.id, provider: m.provider } : {});
  const current = (m: ModelOption) => (m.id ? value.model === m.id && (!m.provider || !value.provider || m.provider === value.provider) : !value.model);
  const activeIdx = Math.min(active, Math.max(0, options.length - 1));
  return (
    <div className="space-y-1.5">
      <label htmlFor={`${id}-q`} className="block text-sm font-medium">
        {label}
      </label>
      <input
        id={`${id}-q`}
        type="search"
        role="combobox"
        aria-expanded="true"
        aria-controls={`${id}-list`}
        aria-activedescendant={options[activeIdx] ? `${id}-${activeIdx}` : undefined}
        aria-autocomplete="list"
        data-autofocus={autoFocus || undefined}
        className={inputCls}
        placeholder="Search models…"
        value={filter}
        onChange={(e) => {
          setFilter(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, options.length - 1));
          else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
          else if (e.key === "Enter" && options[activeIdx]) pick(options[activeIdx]!);
          else return;
          e.preventDefault();
        }}
      />
      {q.isPending ? <Spinner label="Loading models…" /> : null}
      {q.data?.unavailable ? (
        <p className="text-xs text-warn">{backend === "hermes" ? "Hermes" : "Claude"} didn&apos;t list its models; type to use a saved one.</p>
      ) : null}
      <ul
        id={`${id}-list`}
        role="listbox"
        aria-label={`${label} options`}
        className="max-h-60 overflow-y-auto rounded-[10px] border border-line bg-surface p-1"
      >
        {options.map((m, i) => (
          <li
            key={m.key}
            id={`${id}-${i}`}
            role="option"
            aria-selected={current(m)}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(m)}
            className={cx(
              "flex min-h-11 cursor-pointer items-center justify-between gap-2 rounded-[7px] px-2.5 text-[13.5px] dense:min-h-8",
              i === activeIdx && "bg-surface-2",
              current(m) && "font-semibold text-accent",
            )}
          >
            <span className="min-w-0 truncate">{m.label}</span>
            {m.provider ? <span className="shrink-0 text-xs text-muted">{m.provider}</span> : null}
          </li>
        ))}
        {!options.length ? <li className="px-2.5 py-2 text-sm text-muted">No model matches.</li> : null}
      </ul>
    </div>
  );
}

/**
 * The conversation's model (composer chip, `/model`): searchable list from
 * the backend, remembered per conversation; optionally saved as the area's
 * default model.
 */
export function ModelSelectDialog({
  open,
  onClose,
  backend,
  value,
  onChange,
  area,
  onAreaDefault,
}: {
  open: boolean;
  onClose: () => void;
  backend: AssistantBackend;
  value: ModelChoice;
  onChange: (v: ModelChoice) => void;
  /** the conversation's area (offers "Use as <area>'s default") */
  area?: { id: string; title: string; defaultModel: string | null } | null;
  onAreaDefault?: (v: ModelChoice) => void;
}) {
  const [draft, setDraft] = useState<ModelChoice>(value);
  const [asDefault, setAsDefault] = useState(false);
  if (!open) return null;
  return (
    <Dialog
      open
      onClose={onClose}
      title="Model"
      description={`For this conversation${area?.defaultModel ? `. ${area.title} defaults to ${area.defaultModel}` : ""}.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              onChange(draft);
              if (asDefault && area && onAreaDefault) onAreaDefault(draft);
              onClose();
            }}
          >
            Use this model
          </Button>
        </>
      }
    >
      <ModelCombobox backend={backend} value={draft} onChange={setDraft} autoFocus defaultHint={area?.defaultModel ?? undefined} />
      {area && onAreaDefault ? (
        <label className="mt-2 flex min-h-11 items-center gap-2 text-sm dense:min-h-8">
          <input type="checkbox" checked={asDefault} onChange={(e) => setAsDefault(e.target.checked)} />
          Also make it the default for {area.title}
        </label>
      ) : null}
    </Dialog>
  );
}
