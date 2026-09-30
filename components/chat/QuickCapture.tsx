"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, newIdempotencyKey } from "@/lib/client/api";
import { kvDel, kvGet, kvSet } from "@/lib/client/idb";
import { Button, cx, inputCls, useOnline, useToast } from "@/components/ui";
import { SendIcon } from "@/components/icons";
import type { SessionSummary } from "@/lib/hermes";

/**
 * One input that starts a Hermes conversation (optionally with source context)
 * and opens it. The draft survives refresh; offline it is saved, never sent.
 */
export function QuickCapture({ context, placeholder = "Ask Hermes or capture something…" }: { context?: string; placeholder?: string }) {
  const router = useRouter();
  const online = useOnline();
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    kvGet<string>("draft:quick").then((d) => d && setText((t) => t || d));
  }, []);
  useEffect(() => {
    const t = setTimeout(() => (text ? kvSet("draft:quick", text) : kvDel("draft:quick")), 250);
    return () => clearTimeout(t);
  }, [text]);

  async function submit() {
    const input = text.trim();
    if (!input || busy) return;
    if (!online) {
      toast("Offline: your draft is saved and will not be sent until you're back online.", "warn");
      return;
    }
    setBusy(true);
    try {
      const session = await api.post<SessionSummary>("/api/hermes/sessions", { title: input.slice(0, 60) });
      const key = newIdempotencyKey("qc");
      await kvSet(`pending:${session.id}`, { input, key, context });
      await api.post(`/api/hermes/sessions/${encodeURIComponent(session.id)}/runs`, { input, idempotencyKey: key, context });
      await kvDel(`pending:${session.id}`);
      await kvDel("draft:quick");
      setText("");
      router.push(`/chat/${encodeURIComponent(session.id)}`);
    } catch (err) {
      toast((err as Error).message, "danger");
      setBusy(false);
    }
  }

  return (
    <form
      className="card flex items-end gap-2 p-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label htmlFor="quick-capture" className="sr-only">
        Ask Hermes or capture something
      </label>
      <textarea
        id="quick-capture"
        rows={1}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        className={cx(inputCls, "max-h-40 min-h-12 resize-none border-transparent bg-transparent")}
      />
      <Button type="submit" variant="primary" aria-label="Send to Hermes" busy={busy} disabled={!text.trim()} className="shrink-0">
        {!busy ? <SendIcon className="h-5 w-5" /> : null}
      </Button>
    </form>
  );
}
