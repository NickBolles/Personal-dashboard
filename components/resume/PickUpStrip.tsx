"use client";

import Link from "next/link";
import { ButtonLink, SectionHeader } from "@/components/ui";
import { pickUpRows } from "@/lib/resume";
import { ResumeDot, useResume } from "./ResumeView";

export function PickUpStrip() {
  const q = useResume();
  const rows = q.data ? pickUpRows(q.data, 3) : [];
  if (q.error || !rows.length) return null;
  return (
    <section aria-labelledby="pick-up-h" data-testid="pick-up-strip" className="mb-3 min-w-0 [&_.k-sh]:flex-wrap [&_.k-sh-l]:leading-normal">
      <SectionHeader
        id="pick-up-h"
        label="Pick up where you left off"
        action={
          <Link href="/resume" className="inline-flex min-h-11 items-center text-sm text-accent hover:underline sm:min-h-10">
            See all
          </Link>
        }
      />
      <ul className="divide-y divide-line border-y border-line">
        {rows.map((row) => (
          <li key={row.key} className="flex min-w-0 flex-wrap items-center gap-2 py-1" data-testid="pick-up-row">
            <ResumeDot row={row} />
            <div className="min-w-0 flex-1 basis-40">
              <p className="break-words text-sm font-medium">{row.title}</p>
              {row.path ? (
                <p className="truncate text-xs text-muted" title={row.path}>
                  {row.path}
                </p>
              ) : null}
            </div>
            <ButtonLink href={row.href} size="sm" className="min-h-11 sm:min-h-9">
              Resume
            </ButtonLink>
          </li>
        ))}
      </ul>
    </section>
  );
}
