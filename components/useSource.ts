"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import type { ActionSource, SourceStatus } from "@/lib/contracts";
import type { SourceData } from "@/integrations/types";

export function useSource(source: ActionSource) {
  return useQuery({
    queryKey: ["source", source],
    queryFn: () => api.get<{ status: SourceStatus; data?: SourceData }>(`/api/sources/${source}`),
    refetchInterval: 120_000,
  });
}
