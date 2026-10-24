import { requirePage } from "@/server/auth/page";
import { WorkView } from "./WorkView";

export const metadata = { title: "Work" };

/** /work opens on Today; ?view=inbox shows the inbox; ?item=<id> an item (&do=packet|continue|settle|validate from the palette). */
export default async function WorkPage({ searchParams }: { searchParams: Promise<{ item?: string; view?: string; do?: string }> }) {
  await requirePage("work.use");
  const { item, view, do: action } = await searchParams;
  return (
    <WorkView
      // Palette commands navigate here with ?do=…: remount so the requested action opens.
      key={`${item ?? ""}|${view ?? ""}|${action ?? ""}`}
      initialItem={typeof item === "string" ? item : undefined}
      initialView={view === "inbox" ? "inbox" : "today"}
      initialAction={typeof action === "string" ? action : undefined}
    />
  );
}
