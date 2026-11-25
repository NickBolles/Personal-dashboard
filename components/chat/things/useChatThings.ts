"use client";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { isActiveExec, type ChatExecutionResponse } from "@/lib/chat-execution";
import { chatThings, executionAttentionKey, linkAttentionKey, type ChatThingsInput, type ThingsTab } from "@/lib/chat/things";

/** A background-work read the host already keeps current (the Chief of staff thread polls the same endpoint). */
export type ExecutionSource = { data: ChatExecutionResponse | undefined; isError: boolean; isPending: boolean; refetch: () => unknown };

export function useChatThings(
  sessionId: string,
  input: Omit<ChatThingsInput, "execution" | "executionUnavailable" | "now" | "previous">,
  /** Given, this hook reads background work from it and asks for nothing itself. */
  source?: ExecutionSource,
) {
  const own = useQuery({
    queryKey: ["chat-execution", sessionId],
    queryFn: async () => {
      const result = await api.get<ChatExecutionResponse>(`/api/hermes/sessions/${encodeURIComponent(sessionId)}/execution`);
      if (!Array.isArray(result.records) || !Array.isArray(result.sources)) throw new Error("Couldn't check background work");
      return result;
    },
    enabled: !source && !!sessionId,
    refetchInterval: (q) => (q.state.data?.records.some(isActiveExec) ? 20_000 : 60_000),
  });
  // A host's read is taken as it comes: an answer without its lists is "couldn't check", never a crash or a claim.
  const well = (data: ChatExecutionResponse | undefined) => (data && Array.isArray(data.records) && Array.isArray(data.sources) ? data : undefined);
  const execution: ExecutionSource = source ? { ...source, data: well(source.data), isError: source.isError || (!!source.data && !well(source.data)) } : own;
  const [seen, setSeen] = useState<{ sessionId: string; keys: string[] }>({ sessionId, keys: [] });
  const [clock, setClock] = useState(0);
  const [history, setHistory] = useState<{ sessionId: string; line: ReturnType<typeof chatThings>["line"]; transition?: number }>();
  useEffect(() => {
    const tick = () => setClock(Date.now());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);
  const raw = chatThings({
    ...input,
    execution: execution.data,
    executionUnavailable: execution.isError,
    seen: seen.sessionId === sessionId ? seen.keys : [],
    now: clock,
  });
  const previous = history?.sessionId === sessionId ? history : undefined;
  const things = chatThings({
    ...input,
    execution: execution.data,
    executionUnavailable: execution.isError,
    seen: seen.sessionId === sessionId ? seen.keys : [],
    previous: previous?.line,
    transitionSince: previous?.transition ?? clock,
    now: clock,
  });
  const signature = JSON.stringify(things.line);
  const rawId = raw.line.id;
  useEffect(() => {
    // Keep the first observation of a downward transition, not a rolling timeout.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- priority hysteresis snapshot, not derived UI state
    setHistory((h) => ({ sessionId, line: JSON.parse(signature), transition: rawId !== JSON.parse(signature).id ? (h?.transition ?? clock) : undefined }));
  }, [signature, rawId, clock, sessionId]);
  const markSeen = (tab: ThingsTab) =>
    setSeen((previous) => ({
      sessionId,
      keys: [
        ...new Set([
          ...(previous.sessionId === sessionId ? previous.keys : []),
          ...(tab === "Running" ? (execution.data?.records.map(executionAttentionKey) ?? []) : []),
          ...(tab === "PRs" || tab === "Links" ? input.links.map(linkAttentionKey) : []),
          ...(tab === "Outline" ? ["workflow-step"] : []),
        ]),
      ],
    }));
  return { things, execution: execution.data, loading: execution.isPending, error: execution.isError, retry: () => void execution.refetch(), markSeen };
}
