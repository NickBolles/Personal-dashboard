import { redirect } from "next/navigation";
import { requirePage } from "@/server/auth/page";

/**
 * PWA share target. POST shares (with files) are staged by the service worker
 * and land here as ?staged=<id> (or ?error=sw when it wasn't controlling the
 * page). Legacy GET shares (?title&text&url) open the Inbox capture sheet, with
 * "Ask Hermes" as the alternative; without Areas they prefill a Hermes question.
 */
export default async function SharePage({
  searchParams,
}: {
  searchParams: Promise<{ title?: string; text?: string; url?: string; staged?: string; error?: string }>;
}) {
  const user = await requirePage();
  const { title, text, url, staged, error } = await searchParams;
  if (user.capabilities.has("work.use") && (staged || error)) {
    const q = new URLSearchParams();
    if (staged) q.set("staged", staged.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80));
    if (error === "sw") q.set("error", "sw");
    redirect(`/capture?${q}`);
  }
  const draft = [title, text, url].filter(Boolean).join("\n").slice(0, 2000);
  if (user.capabilities.has("work.use")) redirect(`/inbox?capture=${encodeURIComponent(draft)}`);
  redirect(`/chat?new=1&draft=${encodeURIComponent(draft)}`);
}
