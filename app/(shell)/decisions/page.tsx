import { requirePage } from "@/server/auth/page";
import { WorkShell } from "@/components/work/common";
import { DecisionsView } from "@/components/map/DecisionsView";
import "@/components/work/work.css";
import "@/components/map/map.css";

export const metadata = { title: "Needs you" };

/** Decisions inbox: owner decisions, Hermes approvals and workflow proposals in one list. */
export default async function DecisionsPage() {
  await requirePage("work.use", "hermes.chat");
  return (
    <WorkShell>
      <DecisionsView />
    </WorkShell>
  );
}
