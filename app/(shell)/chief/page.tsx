import { requirePage } from "@/server/auth/page";

export const metadata = { title: "Chief of staff" };

/**
 * Expand: the Chief of staff conversation as the page. The shell's one Chief of staff panel (GlobalCoordinator) grows
 * to fill this page instead of being drawn a second time here, so the thread keeps its place, its draft and its
 * run stream on the way in and out. This page only gives that view an address and a name.
 */
export default async function ChiefPage() {
  await requirePage("work.use");
  return <h1 className="sr-only">Chief of staff</h1>;
}
