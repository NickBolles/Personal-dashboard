"use client";

import { useEffect, useMemo, useRef } from "react";
import { buildCustomWidgetSrcdoc, CUSTOM_WIDGET_SANDBOX, SNAPSHOT_MESSAGE_TYPE, type WorkSnapshot } from "@/lib/work";

/**
 * User-authored HTML, isolated: rendered only as an iframe srcdoc with
 * sandbox="allow-scripts" (opaque origin: no cookies, storage or Jarvis APIs)
 * and a CSP meta that blocks every network request. It never touches the app
 * document. The optional snapshot is pushed in with postMessage; nothing the
 * frame sends back is listened to.
 */
export function CustomHtmlWidget({ html, title, snapshot }: { html: string; title: string; snapshot: WorkSnapshot | null }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const srcDoc = useMemo(() => {
    try {
      return buildCustomWidgetSrcdoc(html);
    } catch {
      return buildCustomWidgetSrcdoc("<p>Widget HTML is too large.</p>");
    }
  }, [html]);
  // The sandboxed frame has an opaque ("null") origin, so "*" is the only target that reaches it.
  // The payload is only the read-only work summary the person opted into.
  const post = () => {
    if (snapshot) ref.current?.contentWindow?.postMessage({ type: SNAPSHOT_MESSAGE_TYPE, data: snapshot }, "*");
  };
  useEffect(() => {
    if (snapshot) ref.current?.contentWindow?.postMessage({ type: SNAPSHOT_MESSAGE_TYPE, data: snapshot }, "*");
  }, [snapshot]);
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted">Custom HTML (sandboxed){snapshot ? " · receives a read-only work snapshot" : ""}</p>
      <iframe
        ref={ref}
        title={title}
        sandbox={CUSTOM_WIDGET_SANDBOX}
        srcDoc={srcDoc}
        referrerPolicy="no-referrer"
        onLoad={post}
        className="h-64 w-full rounded-lg border border-line bg-white"
      />
    </div>
  );
}
