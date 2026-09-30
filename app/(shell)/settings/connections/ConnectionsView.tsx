"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { INTEGRATIONS, type PublicIntegration } from "@/integrations/registry";
import { IntegrationForm } from "@/components/integrations/IntegrationForm";
import { Badge, PageHeader, cx } from "@/components/ui";
import { ChevronIcon } from "@/components/icons";

export function ConnectionsView() {
  const q = useQuery({ queryKey: ["integrations"], queryFn: () => api.get<{ integrations: PublicIntegration[] }>("/api/integrations") });
  const [open, setOpen] = useState<string | null>(() => (typeof window !== "undefined" ? window.location.hash.slice(1) || null : null));
  return (
    <div className="mx-auto max-w-3xl px-4 py-5 sm:px-6">
      <PageHeader title="Connections" subtitle="Credentials stay on the Jarvis server, encrypted at rest." />
      <ul className="space-y-2">
        {INTEGRATIONS.map((d) => {
          const i = q.data?.integrations.find((x) => x.kind === d.kind);
          const isOpen = open === d.kind;
          return (
            <li key={d.kind} id={d.kind} className="card">
              <h2>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={`panel-${d.kind}`}
                  onClick={() => setOpen(isOpen ? null : d.kind)}
                  className="flex min-h-16 w-full items-center justify-between gap-2 p-4 text-left"
                >
                  <span className="min-w-0">
                    <span className="block font-semibold">{d.label}</span>
                    <span className="block truncate text-sm text-muted">{d.tagline}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {!i?.enabled ? <Badge>Off</Badge> : i.lastTest?.ok ? <Badge tone="ok">Verified</Badge> : i.lastTest ? <Badge tone="danger">Failing</Badge> : <Badge tone="warn">Untested</Badge>}
                    <ChevronIcon className={cx("h-5 w-5 transition-transform", isOpen && "rotate-90")} />
                  </span>
                </button>
              </h2>
              {isOpen ? (
                <div id={`panel-${d.kind}`} className="border-t border-line p-4">
                  <IntegrationForm kind={d.kind} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
