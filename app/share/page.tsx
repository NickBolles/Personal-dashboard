import { redirect } from "next/navigation";

/** PWA share target (Android share sheet → Jarvis): prefill a Hermes quick capture. */
export default async function SharePage({ searchParams }: { searchParams: Promise<{ title?: string; text?: string; url?: string }> }) {
  const { title, text, url } = await searchParams;
  const draft = [title, text, url].filter(Boolean).join("\n").slice(0, 4000);
  redirect(`/chat?new=1&draft=${encodeURIComponent(draft)}`);
}
