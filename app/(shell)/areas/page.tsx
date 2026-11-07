import { redirect } from "next/navigation";
import { requirePage } from "@/server/auth/page";
import { parseTab } from "@/lib/areas-view";
import { WorkView } from "./WorkView";

export const metadata = { title: "Areas" };

/**
 * /areas opens on Today; ?view=inbox shows the inbox (&capture=<text> opens the capture sheet: the share target);
 * ?item=<id> an item (&do=packet|continue|settle|validate from the palette); &tab=board|activity|graph picks the view tab.
 */
export default async function WorkPage({
  searchParams,
}: {
  searchParams: Promise<{ item?: string; view?: string; do?: string; capture?: string; entry?: string; mode?: string; tab?: string }>;
}) {
  await requirePage("work.use");
  const sp = await searchParams;
  const { item, view, do: action, capture } = sp;
  // The Inbox is its own view now: keep old links (?view=inbox&capture=…&entry=…) working.
  if (view === "inbox") {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (k !== "view" && typeof v === "string") q.set(k, v);
    redirect(`/inbox${q.size ? `?${q}` : ""}`);
  }
  return (
    <WorkView
      // Palette commands navigate here with ?do=…: remount so the requested action opens.
      key={`${item ?? ""}|${view ?? ""}|${action ?? ""}|${sp.tab ?? ""}`}
      initialItem={typeof item === "string" ? item : undefined}
      initialView={view === "tree" ? view : "today"}
      initialTab={parseTab(typeof sp.tab === "string" ? sp.tab : null)}
      initialAction={typeof action === "string" ? action : undefined}
      initialCapture={typeof capture === "string" ? capture.slice(0, 2000) : undefined}
    />
  );
}
