import { requirePage } from "@/server/auth/page";
import { WorkView } from "./WorkView";

export const metadata = { title: "Areas" };

/**
 * /areas opens on Today; ?view=inbox shows the inbox (&capture=<text> opens the capture sheet: the share target);
 * ?item=<id> an item (&do=packet|continue|settle|validate from the palette).
 */
export default async function WorkPage({ searchParams }: { searchParams: Promise<{ item?: string; view?: string; do?: string; capture?: string }> }) {
  await requirePage("work.use");
  const { item, view, do: action, capture } = await searchParams;
  return (
    <WorkView
      // Palette commands navigate here with ?do=…: remount so the requested action opens.
      key={`${item ?? ""}|${view ?? ""}|${action ?? ""}`}
      initialItem={typeof item === "string" ? item : undefined}
      initialView={view === "inbox" || view === "tree" ? view : "today"}
      initialAction={typeof action === "string" ? action : undefined}
      initialCapture={typeof capture === "string" ? capture.slice(0, 2000) : undefined}
    />
  );
}
