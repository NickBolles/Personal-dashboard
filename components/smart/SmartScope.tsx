"use client";

import type { ReactNode } from "react";
import { SmartSession } from "./AssistantText";
import { LiveDecision, SmartReply } from "./live";

/**
 * Everything a conversation hands its smart replies: the session, how a questionnaire answers in it (SmartReply) and
 * how a D-n decision card is drawn live (LiveDecision). One wrapper, so hosts keep their own nesting.
 */
export function SmartScope({
  session,
  reply = null,
  liveDecision = null,
  children,
}: {
  session: string | null;
  reply?: ((text: string) => Promise<boolean>) | null;
  liveDecision?: ((ref: string) => ReactNode | null) | null;
  children: ReactNode;
}) {
  return (
    <SmartSession.Provider value={session}>
      <SmartReply.Provider value={reply}>
        <LiveDecision.Provider value={liveDecision}>{children}</LiveDecision.Provider>
      </SmartReply.Provider>
    </SmartSession.Provider>
  );
}
