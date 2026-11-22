"use client";

import Link from "next/link";
import { useState } from "react";
import { Button, Dialog, Field, Select, StateDot, Textarea, type ThingState } from "@/components/ui";
import { ChevronIcon } from "@/components/icons";
import { BRIEF_IMPROVE_LABEL, BRIEF_LIMITS, type BriefImproveView, type BriefImprovementLive } from "@/lib/brief";
import type { BriefActions } from "./useBrief";

const DOT: Record<BriefImprovementLive, ThingState> = { running: "working", waiting: "needs", failed: "failed", finished: "done", idle: "idle" };

/**
 * "Improve": say what should change and an agent takes it from there. One
 * field; where it goes is the area picked last time, changeable here.
 */
export function ImproveDialog({ improve, actions, onClose }: { improve: BriefImproveView; actions: BriefActions; onClose: () => void }) {
  const [text, setText] = useState("");
  // Untouched, Jarvis picks (and remembers nothing new); once changed, the choice is sent and kept.
  const [area, setArea] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const busy = actions.improve.isPending;
  const ready = text.trim().length >= 3;
  const start = () =>
    actions.improve.mutate(
      { text: text.trim(), ...(area !== undefined ? { areaId: area || null } : {}) },
      { onSuccess: onClose, onError: (e) => setError((e as Error).message || "That didn't start") },
    );
  return (
    <Dialog
      open
      title="Improve the brief"
      onClose={() => !busy && onClose()}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="brief-improve-form" loading={busy} disabled={!ready}>
            Start agent
          </Button>
        </>
      }
    >
      <form
        id="brief-improve-form"
        className="min-w-0 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !busy) start();
        }}
      >
        <Field id="brief-improve-text" label="What should change?" error={error}>
          <Textarea
            id="brief-improve-text"
            rows={4}
            autoFocus
            required
            maxLength={BRIEF_LIMITS.improve}
            value={text}
            invalid={Boolean(error)}
            onChange={(e) => {
              setText(e.target.value);
              setError(undefined);
            }}
          />
        </Field>
        {improve.areas.length ? (
          <Field id="brief-improve-area" label="Goes to">
            <Select id="brief-improve-area" value={area ?? improve.areaId ?? ""} onChange={(e) => setArea(e.target.value)}>
              {improve.areaId === null ? <option value="">Miscellaneous</option> : null}
              {improve.areas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.agent ? `${a.title} · @${a.agent}` : a.title}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
      </form>
    </Dialog>
  );
}

/** What the person asked for from here and how the agent stands on each; a row opens its conversation. */
export function InTheWorks({ improve }: { improve: BriefImproveView }) {
  if (!improve.open.length) return null;
  return (
    <section aria-labelledby="brief-works-h" data-testid="brief-works">
      <h2 className="brief-h" id="brief-works-h">
        In the works
      </h2>
      <ul className="brief-works">
        {improve.open.map((o) => {
          const label = o.live === "waiting" && o.approval ? "Waiting for approval" : BRIEF_IMPROVE_LABEL[o.live];
          return (
            <li key={o.id}>
              <Link href={`/chat/${encodeURIComponent(o.sessionId)}`} data-live={o.live}>
                <StateDot state={DOT[o.live]} />
                <span className="brief-works-t">{o.title}</span>
                <span className="brief-works-s">{label}</span>
                <ChevronIcon className="h-4 w-4" />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
