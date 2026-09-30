import Link from "next/link";
import { DESTINATIONS } from "@/components/navigation/destinations";
import { GearIcon } from "@/components/icons";
import { PageHeader } from "@/components/ui";

export const metadata = { title: "More" };

export default function MorePage() {
  const items = [...DESTINATIONS, { key: "settings", href: "/settings", label: "Settings", icon: GearIcon }];
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
