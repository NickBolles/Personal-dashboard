"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { CHIEF_PATH } from "./GlobalCoordinator";

/**
 * /chat/<id> for the pinned Chief of staff thread leads to /chief, asking for that thread.
 *
 * Done in the browser, not as a server redirect: a message link is /chat/<id>#msg-<message>, the server never sees
 * the fragment, and a server redirect followed from an in-app link drops it. Here it is read and carried along, so
 * the thread on /chief can open that message.
 */
export function ChiefRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace(`${CHIEF_PATH}?thread=pinned${window.location.hash.startsWith("#msg-") ? window.location.hash : ""}`);
  }, [router]);
  return (
    <p className="sr-only" role="status">
      Opening the Chief of staff…
    </p>
  );
}
