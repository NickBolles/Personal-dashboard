import { requirePage } from "@/server/auth/page";
import { ShareLanding } from "@/components/capture/ShareLanding";
import "@/components/work/work.css";

export const metadata = { title: "Capture" };

/** PWA shortcut "Capture": the capture sheet on its own page. */
export default async function CapturePage({ searchParams }: { searchParams: Promise<{ staged?: string; error?: string }> }) {
  await requirePage("work.use");
  const { staged, error } = await searchParams;
  return <ShareLanding staged={staged?.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || undefined} error={error === "sw" ? "sw" : undefined} />;
}
