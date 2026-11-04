"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { WorkPageHeader } from "@/components/work/common";
import { INLINE_OP_EVENT } from "@/components/work/InlineEdit";
import { TodayView } from "@/components/work/today";
import { UndoBar, type UndoOp } from "@/components/work/UndoBar";

/** Today's work queue on its own page: Home's KPI links (#today-proof, #today-settle) land here. */
export function TodayWorkView() {
  const router = useRouter();
  // Inline row edits (F2 rename, next action) report their op here: one Undo bar, as on /areas.
  const [undo, setUndo] = useState<UndoOp | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      const op = (e as CustomEvent<UndoOp>).detail;
      if (op) setUndo(op);
    };
    window.addEventListener(INLINE_OP_EVENT, on);
    return () => window.removeEventListener(INLINE_OP_EVENT, on);
  }, []);
  return (
    <div className="min-w-0 px-3 py-3 sm:px-5 lg:px-6 lg:py-5">
      <WorkPageHeader eyebrow="Areas" title="Work today" />
      <TodayView
        onOpen={(id, action) => router.push(`/areas?item=${encodeURIComponent(id)}${action ? `&do=${encodeURIComponent(action)}` : ""}`)}
        onInbox={() => router.push("/inbox")}
      />
      {undo ? <UndoBar key={undo.id} op={undo} onDone={() => setUndo(null)} /> : null}
    </div>
  );
}
