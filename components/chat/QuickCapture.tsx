"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client/api";
import { kvDel, kvGet, kvSet } from "@/lib/client/idb";
import { Button, cx, inputCls, useOnline, useToast } from "@/components/ui";
import { SendIcon } from "@/components/icons";
import { useAccess } from "@/components/access";
import { useAssistantChoice } from "./backend";
import { useAskHermes } from "./useAskHermes";

/**
 * One input for the core loop (design review D1).
 *  - `capture` (Home): Enter captures to the Inbox (triage later, nothing is
 *    sent anywhere); "Ask Hermes" (⌘/Ctrl+Enter) starts a conversation
 *    instead. Without Areas (no `work.use`) it only asks.
 *  - `ask` (the conversations view): Enter starts a conversation right away;
 *    it lands in Miscellaneous (or `areaId`) with zero filing.
 * The draft survives refresh; offline it is saved, never sent.
 */
export function QuickCapture({
  context,
  initialText,
  placeholder,
  mode = "capture",
  areaId,
}: {
  context?: string;
  initialText?: string;
  placeholder?: string;
  mode?: "capture" | "ask";
  areaId?: string | null;
}) {
  const qc = useQueryClient();
  const online = useOnline();
  const { toast } = useToast();
  const { can } = useAccess();
  const canCapture = mode === "capture" && can("work.use");
  const canAsk = can("hermes.chat");
  const [text, setText] = useState(initialText ?? "");
  const [capturing, setCapturing] = useState(false);
  const { backend } = useAssistantChoice();
  const { ask, busy: asking } = useAskHermes();
  const ta = useRef<HTMLTextAreaElement>(null);
  const draftKey = canCapture ? "draft:capture" : "draft:quick";
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  useEffect(() => {
    kvGet<string>(draftKey).then((d) => d && setText((t) => t || d));
  }, [draftKey]);
  useEffect(() => {
    const t = setTimeout(() => (text ? kvSet(draftKey, text) : kvDel(draftKey)), 250);
    return () => clearTimeout(t);
  }, [text, draftKey]);

  const offline = () => {
    toast("Offline: your draft is saved and will not be sent until you're back online.", "warn");
  };

  async function doAsk() {
    if (!text.trim() || asking) return;
    if (!online) return offline();
    if (await ask(text, { backend, context, areaId })) {
      await kvDel(draftKey);
      setText("");
    }
  }

  async function doCapture() {
    const input = text.trim();
    if (!input || capturing) return;
    if (!online) return offline();
    setCapturing(true);
    try {
      await api.post("/api/work/inbox", { text: input.slice(0, 2000) });
      qc.invalidateQueries({ queryKey: ["work"] });
      await kvDel(draftKey);
      setText("");
      toast("Captured to your Inbox", "ok");
    } catch (err) {
      toast((err as Error).message, "danger");
    } finally {
      setCapturing(false);
    }
  }

  const primary = canCapture ? doCapture : doAsk;
  const label = canCapture ? (canAsk ? "Capture or ask Hermes" : "Capture to your Inbox") : "Ask Hermes";
  const busy = capturing || asking;

  return (
    <form
      className="card flex items-end gap-1.5 p-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        primary();
      }}
    >
      <label htmlFor="quick-capture" className="sr-only">
        {label}
      </label>
      <textarea
        id="quick-capture"
        ref={ta}
        rows={1}
        value={text}
        aria-describedby={canCapture && canAsk ? "quick-capture-hint" : undefined}
        placeholder={placeholder ?? (canCapture ? (canAsk ? "Capture or ask…" : "Capture something…") : "Ask Hermes…")}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if ((e.metaKey || e.ctrlKey) && canCapture && canAsk) doAsk();
            else primary();
          }
        }}
        className={cx(inputCls, "max-h-40 resize-none border-transparent bg-transparent")}
      />
      {canCapture && canAsk ? (
        <span id="quick-capture-hint" className="sr-only">
          Enter captures to your Inbox. Control or Command plus Enter asks Hermes instead.
        </span>
      ) : null}
      {canCapture ? (
        <>
          {canAsk ? (
            <Button
              type="button"
              variant="secondary"
              busy={asking}
              disabled={!text.trim() || busy}
              onClick={doAsk}
              className="shrink-0"
              title="Ask Hermes (Ctrl/⌘ Enter)"
            >
              Ask Hermes
            </Button>
          ) : null}
          <Button type="submit" variant="primary" aria-label="Capture to Inbox" busy={capturing} disabled={!text.trim() || busy} className="shrink-0">
            Capture
          </Button>
        </>
      ) : (
        <Button type="submit" variant="primary" aria-label="Send to Hermes" busy={asking} disabled={!text.trim()} className="shrink-0">
          {!asking ? <SendIcon className="h-5 w-5" /> : null}
        </Button>
      )}
    </form>
  );
}
