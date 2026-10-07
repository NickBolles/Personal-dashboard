"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { Badge, Button, ErrorNote, PageHeader, Spinner, useToast } from "@/components/ui";
import { useAccess } from "@/components/access";

type Row = { id: string; month: string; status: string; closedAt: string | null };

export function StartCheckinButton({ month, label }: { month: string; label?: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const { can } = useAccess();
  const start = useMutation({
    mutationFn: () => api.post<{ id: string }>("/api/finance/checkins", { month }),
    onSuccess: (r) => router.push(`/finance/checkin/${r.id}`),
    onError: (e) => toast((e as Error).message, "danger"),
  });
  if (!can("finance.edit")) return null;
  return (
    <Button variant="primary" busy={start.isPending} onClick={() => start.mutate()}>
      {label ?? "Start check-in"}
    </Button>
  );
}

export const monthLabel = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

export function CheckinList() {
  const q = useQuery({ queryKey: ["finance", "checkins"], queryFn: () => api.get<{ checkins: Row[]; month: string }>("/api/finance/checkins") });
  const month = q.data?.month ?? "";
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-5 sm:px-6">
      <PageHeader
        title="Check-ins"
        actions={q.data && !q.data.checkins.some((c) => c.month === month) ? <StartCheckinButton month={month} label={`Start ${monthLabel(month)}`} /> : null}
      />
      {q.isPending ? <Spinner label="Loading" /> : null}
      {q.error ? <ErrorNote error={q.error} /> : null}
      <ul className="card divide-y divide-line">
        {q.data?.checkins.map((c) => (
          <li key={c.id}>
            <Link href={`/finance/checkin/${c.id}`} className="flex min-h-14 items-center justify-between gap-2 px-4 hover:bg-surface-2">
              <span className="font-medium">{monthLabel(c.month)}</span>
              {c.status === "closed" ? <Badge tone="ok">Closed</Badge> : <Badge tone="accent">Draft</Badge>}
            </Link>
          </li>
        ))}
        {q.data && !q.data.checkins.length ? <li className="p-4 text-sm text-muted">No check-ins yet.</li> : null}
      </ul>
    </div>
  );
}
