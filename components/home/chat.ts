import type { AssistCard } from "@/lib/contracts";

/** /chat?new=1 with a prefilled draft and attached context; nothing is sent until the person presses send. */
export function chatHref(chat: NonNullable<AssistCard["chat"]>) {
  return `/chat?new=1&context=${encodeURIComponent(chat.context)}&draft=${encodeURIComponent(chat.draft)}`;
}
