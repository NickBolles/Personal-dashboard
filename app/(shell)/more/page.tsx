import Link from "next/link";
import { allowed, DESTINATIONS } from "@/components/navigation/destinations";
import { requirePage } from "@/server/auth/page";
import { GearIcon } from "@/components/icons";
import { PageHeader } from "@/components/ui";

export const metadata = { title: "More" };

export default async function MorePage() {
  const user = await requirePage();
  const caps = [...user.capabilities];
  const items = [...DESTINATIONS.filter((d) => allowed(d, caps)), { key: "settings", href: "/settings", label: "Settings", icon: GearIcon }];
  return (
    <div className="mx-auto max-w-3xl px-4 py-5 sm:px-6">
      <PageHeader title="More" />
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {items.map((d) => {
          const Icon = d.icon;
          return (
            <li key={d.key}>
              <Link href={d.href} className="card flex min-h-24 flex-col items-start justify-between gap-2 p-4 hover:border-line-strong">
                <Icon className="h-6 w-6 text-accent" />
                <span className="font-medium">{d.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
