import { requirePage } from "@/server/auth/page";
import { WorkShell } from "@/components/work/common";

export default async function WorkLayout({ children }: { children: React.ReactNode }) {
  await requirePage("work.use");
  return <WorkShell>{children}</WorkShell>;
}
