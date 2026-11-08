import { Suspense } from "react";
import { requirePage } from "@/server/auth/page";
import { WorkShell } from "@/components/work/common";
import { ResumeView } from "@/components/resume/ResumeView";
import "@/components/work/work.css";

export const metadata = { title: "In flight" };

export default async function ResumePage() {
  await requirePage("work.use");
  return (
    <WorkShell>
      <Suspense>
        <ResumeView />
      </Suspense>
    </WorkShell>
  );
}
