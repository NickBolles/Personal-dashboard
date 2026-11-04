"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import type { QuickAction } from "@/lib/quick-actions";
import { useToast } from "@/components/ui";

export function useQuickActions(enabled = true) {
  return useQuery({
    queryKey: ["quick-actions"],
    queryFn: () => api.get<{ actions: QuickAction[] }>("/api/quick-actions"),
    enabled,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}
export function useQuickActionWrite() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [undoId, setUndoId] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["quick-actions"] });
  const write = useMutation({
    mutationFn: async ({
      path,
      body = {},
      method = "post",
      message,
    }: {
      path: string;
      body?: unknown;
      method?: "post" | "patch" | "delete";
      message?: string;
    }) => {
      const result = method === "delete" ? await api.del<{ opId: string }>(path) : await api[method]<{ opId: string }>(path, body);
      return { ...result, message };
    },
    onSuccess: (r) => {
      setUndoId(r.opId);
      if (r.message) toast(r.message);
      void refresh();
    },
    onError: (err) => toast((err as Error).message, "danger"),
  });
  const undo = useMutation({
    mutationFn: () => api.post("/api/quick-actions/undo", { opId: undoId }),
    onSuccess: () => {
      setUndoId(null);
      toast("Undone");
      void refresh();
    },
    onError: (err) => toast((err as Error).message, "danger"),
  });
  return { write, undo, undoId };
}
