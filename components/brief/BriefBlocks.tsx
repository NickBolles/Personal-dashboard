"use client";

import Link from "next/link";
import { useState } from "react";
import { Button, Checkbox, Input } from "@/components/ui";
import { useAccess } from "@/components/access";
import { ChatIcon, ChevronIcon, ThumbDownIcon, ThumbUpIcon } from "@/components/icons";
import { sparkPoints, sum } from "@/lib/pulse";
import { BRIEF_KIND_LABEL, BRIEF_LIMITS, type BriefBlockView, type BriefFeedbackView, type BriefVerdict, type BriefWidgetData } from "@/lib/brief";
import type { BriefActions } from "./useBrief";

/**
 * "Right call" / "Wrong call" on a pick or a card. A wrong call asks (optionally) what was off:
 * that sentence goes into the next build's context, which is how the brief gets corrected.
 */
export function Feedback({
  briefId,
  targetKey,
  about,
  current,
  send,
}: {
  briefId: string | null;
  targetKey: string;
  about: string;
  current: BriefFeedbackView | undefined;
  send: BriefActions["sendFeedback"];
}) {
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  if (!briefId) return null;
  const choose = (verdict: BriefVerdict) => {
    if (current?.verdict === verdict) {
      setAsking(false);
      return void send(briefId, targetKey, null);
    }
    void send(briefId, targetKey, verdict);
    setNote("");
    setAsking(verdict === "down");
  };
  const id = `fb-${targetKey.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  return (
    <>
      <span className="brief-fb" role="group" aria-label={`Feedback on ${about}`}>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-pressed={current?.verdict === "up"}
          data-verdict="up"
          icon={<ThumbUpIcon className="h-4 w-4" />}
          onClick={() => choose("up")}
        >
          Right call: {about}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-pressed={current?.verdict === "down"}
          data-verdict="down"
          icon={<ThumbDownIcon className="h-4 w-4" />}
          onClick={() => choose("down")}
        >
          Wrong call: {about}
        </Button>
      </span>
      {asking && current?.verdict === "down" ? (
        <form
          className="brief-fb-note"
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim()) void send(briefId, targetKey, "down", note.trim(), true);
            setAsking(false);
          }}
        >
          <Input
            id={id}
            aria-label={`What was off about ${about}? (optional)`}
            placeholder="What was off?"
            value={note}
            maxLength={BRIEF_LIMITS.feedbackNote}
            onChange={(e) => setNote(e.target.value)}
            autoFocus
          />
          <Button type="submit" size="sm" variant="secondary">
            {note.trim() ? "Save" : "Skip"}
          </Button>
        </form>
      ) : current?.note ? (
        <p className="brief-because w-full">You said: {current.note}</p>
      ) : null}
    </>
  );
}

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function Schedule({ w }: { w: Extract<BriefWidgetData, { kind: "schedule" }> }) {
  if (!w.events.length) return <p className="brief-card-text">{w.known ? "Nothing on the calendar today." : "Calendar isn't connected."}</p>;
  const next = w.events.find((e) => !e.allDay && !e.past)?.id;
  return (
    <ol className="brief-sched">
      {w.events.map((e) => (
        <li key={e.id} data-past={e.past || undefined} data-next={e.id === next || undefined}>
          <time dateTime={e.startsAt} data-dynamic>
            {e.allDay ? "All day" : time(e.startsAt)}
          </time>
          <span>
            {e.title}
            {e.id === next ? <span className="sr-only"> (next)</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Momentum({ w }: { w: Extract<BriefWidgetData, { kind: "momentum" }> }) {
  const max = Math.max(1, ...w.completed, ...w.added);
  const width = 220;
  const height = 36;
  return (
    <div className="mt-2">
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} preserveAspectRatio="none" aria-hidden="true" className="overflow-visible">
        <polyline
          points={sparkPoints(w.added, width, height, max)}
          fill="none"
          stroke="var(--bdc)"
          strokeWidth="1.25"
          strokeDasharray="2 2"
          vectorEffect="non-scaling-stroke"
        />
        <polyline points={sparkPoints(w.completed, width, height, max)} fill="none" stroke="var(--ac)" strokeWidth="1.75" vectorEffect="non-scaling-stroke" />
      </svg>
      <p className="brief-card-text" data-dynamic>
        <strong className="font-semibold text-text">{sum(w.completed)}</strong> completed, <strong className="font-semibold text-text">{sum(w.added)}</strong>{" "}
        added in 14 days
      </p>
    </div>
  );
}

const shortDay = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

/** Completed workouts per week for four weeks; the last bar is this week. */
function Training({ w }: { w: Extract<BriefWidgetData, { kind: "training" }> }) {
  const max = Math.max(1, ...w.weeks.map((x) => x.sessions));
  return (
    <div className="mt-2">
      <ol className="brief-train" aria-label="Workouts per week">
        {w.weeks.map((x, i) => (
          <li key={x.start} data-now={i === w.weeks.length - 1 || undefined}>
            <span className="brief-train-n">{x.sessions}</span>
            <span className="brief-train-bar" aria-hidden="true">
              <span style={{ blockSize: `${Math.round((x.sessions / max) * 100)}%` }} />
            </span>
            <span className="brief-train-l" data-dynamic>
              {i === w.weeks.length - 1 ? "This week" : shortDay(x.start)}
            </span>
          </li>
        ))}
      </ol>
      {w.last ? (
        <p className="brief-because" data-dynamic>
          Last: {w.last.title}, {shortDay(w.last.date)}
        </p>
      ) : null}
    </div>
  );
}

function Widget({ w }: { w: BriefWidgetData }) {
  if (w.kind === "schedule") return <Schedule w={w} />;
  if (w.kind === "momentum") return <Momentum w={w} />;
  if (w.kind === "training") return <Training w={w} />;
  if (w.kind === "household")
    return (
      <ul className="brief-list mt-2">
        {w.exceptions.map((e) => (
          <li key={e.href}>
            <Link href={e.href} className="hover:underline">
              {e.name}: {e.reason}
            </Link>{" "}
            <small>{e.severity}</small>
          </li>
        ))}
      </ul>
    );
  if (w.kind === "dates")
    return (
      <ul className="brief-list mt-2">
        {w.dates.map((d) => (
          <li key={d.id}>
            {d.title} <small>{d.inDays === 0 ? "today" : d.inDays === 1 ? "tomorrow" : `in ${d.inDays} days`}</small>
          </li>
        ))}
      </ul>
    );
  return (
    <div>
      <p className="brief-card-text">
        <Link href="/daily-compass" className="font-medium text-text hover:underline">
          {w.completed ? "Check-in done for today" : w.inWindow ? "Check-in is open now" : `Check-in opens ${w.windowLabel.split("–")[0]}`}
        </Link>
      </p>
      {w.focus.length ? (
        <div className="brief-chips" aria-label="Today's focus">
          {w.focus.map((f) => (
            <span key={f} className="brief-chip">
              {f}
            </span>
          ))}
        </div>
      ) : null}
      {w.yesterday?.tomorrow ? <p className="brief-because">Last night you named: {w.yesterday.tomorrow}</p> : null}
    </div>
  );
}

const ABOUT_YOU = new Set<BriefBlockView["kind"]>(["insight", "callout", "idea"]);

/** The folded steps, in a word: how many, and how many are ticked off. */
function stepsWord(total: number, done: number) {
  if (done) return `${done} of ${total} done`;
  return total === 1 ? "1 step" : `${total} steps`;
}

export function BriefBlock({
  block,
  briefId,
  feedback,
  send,
  tick,
  fold = false,
}: {
  block: BriefBlockView;
  briefId: string | null;
  feedback: BriefFeedbackView | undefined;
  send: BriefActions["sendFeedback"];
  tick: BriefActions["tick"];
  /** in a carousel: the small steps sit behind a toggle, so one long card does not stretch the others */
  fold?: boolean;
}) {
  const label = BRIEF_KIND_LABEL[block.kind];
  const titleId = `brief-${block.id}`;
  const canChat = useAccess().can("hermes.chat");
  // A question on a card is answered in a chat: the card goes along as context, nothing is sent until the person sends it.
  const answerHref =
    block.ask && canChat
      ? `/chat?new=1&context=${encodeURIComponent(`From my brief today. ${label}: ${[block.title, block.text, block.ask].filter(Boolean).join(" ")}`.slice(0, 900))}`
      : null;
  const [pending, setPending] = useState<Record<number, boolean>>({});
  const [open, setOpen] = useState(false);
  const saved = new Set(block.done ?? []);
  const isDone = (i: number) => pending[i] ?? saved.has(i);
  const toggle = (i: number, v: boolean) => {
    if (!briefId) return;
    setPending((p) => ({ ...p, [i]: v }));
    void tick(briefId, block.id, i, v).finally(() =>
      setPending((p) => {
        const { [i]: _settled, ...rest } = p;
        return rest;
      }),
    );
  };
  return (
    <article
      className="brief-card"
      data-kind={block.kind}
      data-family={block.widget ? "widget" : ABOUT_YOU.has(block.kind) ? "you" : "day"}
      aria-labelledby={titleId}
    >
      <p className="brief-kind" id={block.title ? undefined : titleId}>
        {label}
      </p>
      {briefId && !block.widget ? (
        <Feedback briefId={briefId} targetKey={`block:${block.id}`} about={block.title ?? label} current={feedback} send={send} />
      ) : null}
      {block.title ? (
        <h3 className="brief-card-title" id={titleId}>
          {block.title}
        </h3>
      ) : null}
      {block.widget ? <Widget w={block.widget} /> : null}
      {block.text ? <p className="brief-card-text">{block.text}</p> : null}
      {block.steps?.length && fold ? (
        <Button
          variant="ghost"
          size="sm"
          className="brief-fold"
          aria-expanded={open}
          icon={<ChevronIcon className="h-3.5 w-3.5" />}
          onClick={() => setOpen((v) => !v)}
        >
          {stepsWord(block.steps.length, block.steps.filter((_s, i) => isDone(i)).length)}
          <span className="sr-only">: {block.title ?? label}</span>
        </Button>
      ) : null}
      {block.steps?.length && (!fold || open) ? (
        <ul className="brief-steps" data-plain={briefId ? undefined : true}>
          {block.steps.map((s, i) => (
            <li key={s}>{briefId ? <Checkbox celebrate checked={isDone(i)} onChange={(v) => toggle(i, v)} label={s} /> : s}</li>
          ))}
        </ul>
      ) : null}
      {block.ask && answerHref ? (
        <Link href={answerHref} className="brief-reply" aria-label={`Answer: ${block.ask}`}>
          <ChatIcon className="h-4 w-4" />
          <span>{block.ask}</span>
          <ChevronIcon className="h-4 w-4" />
        </Link>
      ) : block.ask ? (
        <p className="brief-ask">{block.ask}</p>
      ) : null}
      {block.actions?.length ? (
        <div className="brief-chips">
          {block.actions.map((a) =>
            a.href && a.state === "open" ? (
              <Link key={a.actionId} href={a.href} className="brief-chip" data-state={a.state}>
                {a.title}
              </Link>
            ) : (
              <span key={a.actionId} className="brief-chip" data-state={a.state}>
                {a.title}
                {a.state === "done" ? <span className="sr-only"> (done)</span> : null}
              </span>
            ),
          )}
        </div>
      ) : null}
      {block.basis?.length ? (
        <p className="brief-because">
          <b>From</b> {block.basis.map((b) => (b.kind === "note" ? `your note “${b.label}”` : b.label.charAt(0).toLowerCase() + b.label.slice(1))).join(" · ")}
        </p>
      ) : null}
    </article>
  );
}
