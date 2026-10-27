"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { kvSet } from "@/lib/client/idb";
import { refreshSessionLists } from "@/lib/client/session-lists";
import { BACKEND_LABELS } from "@/lib/assistant";
import { BackendSwitch, useAssistantChoice } from "@/components/chat/backend";
import { Button, Dialog, useToast } from "@/components/ui";
import { Markdown } from "@/components/markdown/Markdown";
import type { WorkDetail, WorkLink } from "@/lib/work";

/**
 * "Continue in new conversation": the server creates the conversation through
 * the assistant layer (same backend choice as the new-chat UI) and links it as
 * a source with handoff_from lineage. The handoff Markdown becomes the
 * conversation's draft (the composer's own per-conversation draft store); the
 * person reviews it and presses Send. Nothing is sent from here.
 */
export function ContinueDialog({ d, markdown, onClose }: { d: WorkDetail; markdown: string; onClose: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { backend, available } = useAssistantChoice();
  const [busy, setBusy] = useState(false);
  const p = d.packets[0];

  async function create() {
    setBusy(true);
    try {
      const r = await api.post<{ session: { id: string; title: string }; link: WorkLink }>(`/api/work/items/${encodeURIComponent(d.item.id)}/continue`, {
        backend,
      });
      await kvSet(`draft:${r.session.id}`, markdown);
      void refreshSessionLists(qc).catch(() => {});
      qc.invalidateQueries({ queryKey: ["work"] });
      toast("Conversation created. Review the draft, then press Send.", "ok");
      router.push(`/chat/${encodeURIComponent(r.session.id)}`);
    } catch (e) {
      toast((e as Error).message, "danger");
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Continue in a new conversation"
      description={
        <>
          Starts a new conversation linked to this item as its source{p ? ` (handoff from packet v${p.version})` : ""}. The handoff below is put in the message
          box as a draft: nothing is sent until you press Send.
        </>
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={!available.length} onClick={create}>
            Create conversation
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">Ask</span>
          {available.length > 1 ? <BackendSwitch /> : <span>{available.length ? BACKEND_LABELS[backend].label : "No assistant is set up"}</span>}
        </div>
        {/* Rendered the way the conversation will show it; the raw Markdown is what gets sent. */}
        <div
          data-testid="continue-preview"
          role="region"
          aria-label="Handoff preview"
          tabIndex={0}
          className="max-h-72 overflow-auto rounded-[10px] border border-line bg-surface-2 px-3 py-2.5 text-[13px]"
        >
          <Markdown text={markdown} headingOffset={2} />
        </div>
      </div>
    </Dialog>
  );
}
