"use client";

import Link from "next/link";
import type { WorkflowKind } from "@/lib/jarvis-ui/types";
import { WorkflowSurface } from "./WorkflowSurface";

/** /areas/brief and /areas/plan: one Jarvis-built workflow surface per page, reachable from Today. */
export function WorkflowPage({ kind, title, subtitle }: { kind: WorkflowKind; title: string; subtitle: string }) {
  return (
    <div className="mx-auto w-full max-w-[1100px] px-3 py-3 sm:px-5 lg:px-6 lg:py-5">
      <header className="mb-2">
        <Link href="/areas" className="tap inline-flex items-center text-[13px] text-accent hover:underline">
          ← Today
        </Link>
        <h1 className="text-xl leading-tight font-semibold tracking-tight">{title}</h1>
        <p className="text-[13px] text-muted">{subtitle}</p>
      </header>
      <WorkflowSurface kind={kind} />
    </div>
  );
}
