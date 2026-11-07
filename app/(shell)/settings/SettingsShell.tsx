"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useAccess } from "@/components/access";
import { Page } from "@/components/ui";
import { settingsSections } from "./sections";

export function SettingsShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { isAdmin, can } = useAccess();
  if (pathname === "/settings") return children;
  return (
    <Page className="@container">
      <div className="grid min-w-0 grid-cols-1 items-start gap-4 min-[1024px]:@min-[720px]:grid-cols-[176px_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className="sticky top-4 hidden min-w-0 min-[1024px]:@min-[720px]:block">
          <Link href="/settings" className="tap mb-2 flex items-center px-2 text-sm font-semibold">
            Settings
          </Link>
          <ul className="space-y-0.5">
            {settingsSections(isAdmin, can).map((section) => (
              <li key={section.href}>
                <Link
                  href={section.href}
                  aria-current={pathname === section.href || pathname.startsWith(`${section.href}/`) ? "page" : undefined}
                  className="tap flex min-w-0 items-center rounded-md px-2 py-1.5 text-sm text-muted hover:bg-surface-2 aria-[current=page]:bg-surface-2 aria-[current=page]:font-semibold aria-[current=page]:text-foreground"
                >
                  {section.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0">{children}</div>
      </div>
    </Page>
  );
}
