import { redirect } from "next/navigation";
import { requirePage } from "@/server/auth/page";

/**
 * PWA share target (Android share sheet → Jarvis). With Areas the shared text
 * goes to the Inbox capture sheet, with "Ask Hermes" as the alternative on
 * that sheet (design review D1); without it, it prefills a Hermes question.
 */
export default async function SharePage({ searchParams }: { searchParams: Promise<{ title?: string; text?: string; url?: string }> }) {
  const user = await requirePage();
  const { title, text, url } = await searchParams;
  const draft = [title, text, url].filter(Boolean).join("\n").slice(0, 2000);
  if (user.capabilities.has("work.use")) redirect(`/areas?view=inbox&capture=${encodeURIComponent(draft)}`);
  redirect(`/chat?new=1&draft=${encodeURIComponent(draft)}`);
}
