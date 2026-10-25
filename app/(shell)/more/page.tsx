import Link from "next/link";
import { allowed, DESTINATIONS } from "@/components/navigation/destinations";
import { requirePage } from "@/server/auth/page";
import { GearIcon } from "@/components/icons";
import { Page, PageHeader } from "@/components/ui";

export const metadata = { title: "More" };

export default async function MorePage() {
  const user = await requirePage();
  const caps = [...user.capabilities];
  const items = [...DESTINATIONS.filter((d) => allowed(d, caps)), { key: "settings", href: "/settings", label: "Settings", icon: GearIcon }];
  return (
    <Page width="medium">
      <PageHeader title="More" subtitle="Every space you can open." />
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {items.map((d) => {
          const Icon = d.icon;
          return (
            <li key={d.key}>
              <Link href={d.href} className="card press flex min-h-14 items-center gap-3 px-3 py-2.5 hover:border-line-strong hover:bg-surface-2">
                <span aria-hidden="true" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-accent-soft text-accent">
                  <Icon className="h-[18px] w-[18px]" />
                </span>
                <span className="min-w-0 leading-tight font-semibold">{d.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </Page>
  );
}
