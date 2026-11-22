import { Suspense } from "react";
import { requirePage } from "@/server/auth/page";
import { WorkShell } from "@/components/work/common";
import { ReviewQueue } from "@/components/tasks/ReviewQueue";
import "@/components/work/work.css";

export const metadata = { title: "Ready for review" };

export default async function ReviewPage({ searchParams }: { searchParams: Promise<{ scope?: string }> }) {
  await requirePage("work.use");
  const { scope } = await searchParams;
  return (
    <WorkShell>
      <Suspense>
        <ReviewQueue scope={scope && scope.length <= 64 ? scope : "all"} />
      </Suspense>
    </WorkShell>
  );
}
