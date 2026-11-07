import { requirePage } from "@/server/auth/page";
import { Page } from "@/components/ui";
import { FeedbackInbox } from "@/components/feedback/FeedbackInbox";

export const metadata = { title: "Feedback" };

/** Feedback inbox: ratings of agent replies (feedback loop). */
export default async function FeedbackPage() {
  await requirePage("hermes.chat");
  return (
    <Page width="medium">
      <FeedbackInbox />
    </Page>
  );
}
