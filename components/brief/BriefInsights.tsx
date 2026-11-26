"use client";

import { Button } from "@/components/ui";
import { BRIEF_KIND_LABEL, BRIEF_NOTE_KIND_LABEL, type BriefBlockView, type BriefFeedbackView, type BriefNoteView, type BriefView } from "@/lib/brief";
import { BriefBlock } from "./BriefBlocks";
import { Carousel, type Slide } from "./Carousel";
import type { BriefActions } from "./useBrief";

/** Cards about the person, in the order they read best: what was noticed, then an idea, then the honest take. */
export const ABOUT_YOU: BriefBlockView["kind"][] = ["insight", "idea", "callout"];

/** Something lasting Jarvis proposes to remember. Dashed teal: nothing uses it until it is kept. */
function Proposal({ note, actions }: { note: BriefNoteView; actions: BriefActions }) {
  return (
    <article className="brief-card brief-propose" data-family="you">
      <p className="brief-kind">
        <span>{BRIEF_NOTE_KIND_LABEL[note.kind]}</span>
        <span className="brief-kind-sub">to remember</span>
      </p>
      <h3 className="brief-card-title">{note.text}</h3>
      {note.evidence ? <p className="brief-because">{note.evidence}</p> : null}
      <div className="brief-propose-actions">
        <Button size="sm" variant="agent" onClick={() => void actions.patchNote(note, "active")}>
          Keep<span className="sr-only">: {note.text}</span>
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void actions.patchNote(note, "dismissed")}>
          Not true<span className="sr-only">: {note.text}</span>
        </Button>
      </div>
    </article>
  );
}

/**
 * Insights: one carousel of what the brief has to say about the person. What it
 * noticed, an idea, an honest take (their small steps folded), then anything
 * it proposes to remember. Cards keep their own height; the row fits the ones showing.
 */
export function BriefInsights({ view, actions, fb }: { view: BriefView; actions: BriefActions; fb: (key: string) => BriefFeedbackView | undefined }) {
  const blocks = view.brief.blocks.filter((b) => ABOUT_YOU.includes(b.kind)).sort((a, b) => ABOUT_YOU.indexOf(a.kind) - ABOUT_YOU.indexOf(b.kind));
  const slides: Slide[] = [
    ...blocks.map((b) => ({
      key: b.id,
      label: BRIEF_KIND_LABEL[b.kind],
      node: <BriefBlock block={b} briefId={view.brief.id} feedback={fb(`block:${b.id}`)} send={actions.sendFeedback} tick={actions.tick} fold />,
    })),
    ...view.proposals.map((n) => ({
      key: n.id,
      label: `Atlas noticed: ${BRIEF_NOTE_KIND_LABEL[n.kind]}`,
      node: <Proposal note={n} actions={actions} />,
    })),
  ];
  return <Carousel id="brief-insights-h" title="Insights" slides={slides} cycle={view.settings.cycle} fit testId="brief-insights" />;
}
