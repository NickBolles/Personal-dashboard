"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { BACKEND_LABELS, type AssistantBackend, type AssistantStatus } from "@/lib/assistant";
import { useAccess } from "@/components/access";
import { cx } from "@/components/ui";

const KEY = "jarvis.assistant.backend";
const EVENT = "jarvis:assistant-backend";

/** Which assistant new conversations go to on this device (falls back to the household default). */
export function useAssistantChoice() {
  const { can } = useAccess();
  const q = useQuery({ queryKey: ["assistant"], queryFn: () => api.get<AssistantStatus>("/api/assistant"), enabled: can("hermes.chat"), staleTime: 60_000 });
  const [picked, setPicked] = useState<AssistantBackend>();
  useEffect(() => {
    const read = () => {
      try {
        const v = localStorage.getItem(KEY);
        if (v === "hermes" || v === "claude") setPicked(v);
      } catch {
        /* storage unavailable */
      }
    };
    read();
    // Every switch and capture box on the page follows the same choice.
    window.addEventListener(EVENT, read);
    return () => window.removeEventListener(EVENT, read);
  }, []);
  const available = (q.data?.backends ?? []).filter((b) => b.available).map((b) => b.id);
  const backend = picked && available.includes(picked) ? picked : (q.data?.defaultBackend ?? "hermes");
  const choose = (b: AssistantBackend) => {
    setPicked(b);
    try {
      localStorage.setItem(KEY, b);
    } catch {
      /* storage unavailable */
    }
    window.dispatchEvent(new Event(EVENT));
  };
  return { backend, available, choose, status: q.data };
}

/** Segmented Hermes | Claude switch, shown only when both are set up. */
export function BackendSwitch({ className }: { className?: string }) {
  const { backend, available, choose } = useAssistantChoice();
  if (available.length < 2) return null;
  return (
    <div role="group" aria-label="Ask" className={cx("inline-flex overflow-hidden rounded-xl border border-line-strong text-sm", className)}>
      {available.map((b) => (
        <button
          key={b}
          type="button"
          aria-pressed={backend === b}
          title={BACKEND_LABELS[b].description}
          onClick={() => choose(b)}
          className={cx("min-h-11 px-3 font-medium", backend === b ? "bg-accent text-accent-contrast" : "bg-surface hover:bg-surface-2")}
        >
          {BACKEND_LABELS[b].label}
        </button>
      ))}
    </div>
  );
}
