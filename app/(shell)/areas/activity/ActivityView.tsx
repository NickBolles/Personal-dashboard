"use client";

import { ActivityFeed } from "@/components/work/ActivityFeed";
import { WorkPageHeader } from "@/components/work/common";

/** Global activity timeline: everything that changed across Areas, newest first. */
export function ActivityView({ areas, initialArea }: { areas: { id: string; title: string }[]; initialArea: string }) {
  return (
    <div className="mx-auto w-full max-w-[960px] min-w-0 px-3 py-3 sm:px-5 lg:px-6 lg:py-4">
      <WorkPageHeader eyebrow="All areas" title="Activity" subtitle="Edits, status changes, filing, merges and agent runs, newest first." />
      <ActivityFeed areas={areas} initialArea={initialArea} label="All activity" />
    </div>
  );
}
