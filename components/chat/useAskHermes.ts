"use client";

import { SMART_CAPABILITY } from "@/lib/jarvis-ui/types";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, newIdempotencyKey } from "@/lib/client/api";
import { refreshSessionLists } from "@/lib/client/session-lists";
import { kvDel, kvSet } from "@/lib/client/idb";
import { useToast } from "@/components/ui";
import type { SessionSummary } from "@/lib/hermes";
import type { AssistantBackend } from "@/lib/assistant";

/**
 * "Ask Hermes": start a conversation right away (zero filing: it lands in
 * Miscellaneous, or under `areaId` when asked from inside an area or item),
 * send the first message and open it. Shared by Home, the conversations view,
 * the capture sheet and the share target.
 */
export function useAskHermes() {
  const router = useRouter();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const ask = async (input: string, opts: { backend?: AssistantBackend; context?: string; areaId?: string | null } = {}) => {
    const text = input.trim();
    if (!text || busy) return false;
    setBusy(true);
    try {
      const session = await api.post<SessionSummary>("/api/hermes/sessions", {
        title: text.slice(0, 60),
        backend: opts.backend,
        areaId: opts.areaId ?? undefined,
      });
      // Refresh even if the run fails; the conversation already exists.
      void refreshSessionLists(qc).catch(() => toast("Conversation created, but the list could not refresh. Try Refresh conversations.", "warn"));
      qc.invalidateQueries({ queryKey: ["work"] });
      const key = newIdempotencyKey("qc");
      await kvSet(`pending:${session.id}`, { input: text, key, context: opts.context });
      await api.post(`/api/hermes/sessions/${encodeURIComponent(session.id)}/runs`, {
        input: text,
        idempotencyKey: key,
        context: opts.context,
        capabilities: [SMART_CAPABILITY],
      });
      await kvDel(`pending:${session.id}`);
      router.push(`/chat/${encodeURIComponent(session.id)}`);
      return true;
    } catch (err) {
      toast((err as Error).message, "danger");
      setBusy(false);
      return false;
    }
  };
  /** An empty conversation (no first message): "New chat". */
  const start = async (opts: { backend?: AssistantBackend; areaId?: string | null } = {}) => {
    if (busy) return false;
    setBusy(true);
    try {
      const session = await api.post<SessionSummary>("/api/hermes/sessions", { backend: opts.backend, areaId: opts.areaId ?? undefined });
      void refreshSessionLists(qc).catch(() => {});
      qc.invalidateQueries({ queryKey: ["work"] });
      router.push(`/chat/${encodeURIComponent(session.id)}`);
      return true;
    } catch (err) {
      toast((err as Error).message, "danger");
      setBusy(false);
      return false;
    }
  };
  return { ask, start, busy };
}
