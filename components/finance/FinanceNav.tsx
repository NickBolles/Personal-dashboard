"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { HideAmountsProvider, HideAmountsToggle } from "./money";

const TABS = [
  { href: "/finance", label: "Overview", match: (p: string) => p === "/finance" },
  { href: "/finance/checkin", label: "Check-in", match: (p: string) => p.startsWith("/finance/checkin") },
  { href: "/finance/accounts", label: "Accounts", match: (p: string) => p.startsWith("/finance/accounts") },
  { href: "/finance/funds", label: "Funds & reserve", match: (p: string) => p.startsWith("/finance/funds") },
  { href: "/finance/plan", label: "Plan", match: (p: string) => p.startsWith("/finance/plan") },
];

/** Finance section chrome: tabs + the per-device hide-amounts switch. */
export function FinanceShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  return (
    <HideAmountsProvider>
      <div className="mx-auto max-w-[1240px] px-4 pt-4 sm:px-6 dense:px-7 dense:pt-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {/* The shared segmented control; phones scroll it sideways rather than wrapping. */}
          <nav aria-label="Finance" className="scroll-x-clean max-w-full min-w-0">
            <ul className="seg">
              {TABS.map((t) => (
                <li key={t.href}>
                  <Link href={t.href} aria-current={t.match(path) ? "page" : undefined} className="seg-item">
                    {t.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <HideAmountsToggle />
        </div>
      </div>
      {children}
    </HideAmountsProvider>
  );
}
