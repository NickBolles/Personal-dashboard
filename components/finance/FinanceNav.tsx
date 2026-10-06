"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cx } from "@/components/ui";
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
      <div className="mx-auto max-w-6xl px-4 pt-5 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <nav aria-label="Finance">
            <ul className="flex flex-wrap gap-1">
              {TABS.map((t) => (
                <li key={t.href}>
                  <Link
                    href={t.href}
                    aria-current={t.match(path) ? "page" : undefined}
                    className={cx(
                      "inline-flex min-h-11 items-center rounded-xl px-3 text-sm font-medium",
                      t.match(path) ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-text",
                    )}
                  >
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
