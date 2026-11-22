"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Banner, Button, ButtonLink, ErrorNote, Page, ProposedBox, Skeleton, Toast, useOnline } from "@/components/ui";
import { CheckIcon } from "@/components/icons";
import { formatDueWhen } from "@/components/actions/format";
import type { BriefBlockView, BriefFeedbackView, BriefPickView, BriefView as View } from "@/lib/brief";
import { WhileAwayCard } from "@/components/agents/WhileAwayCard";
import { PickUpStrip } from "@/components/resume/PickUpStrip";
import { useAccess } from "@/components/access";
import { BriefBlock, Feedback } from "./BriefBlocks";
import { BriefDeck } from "./BriefDeck";
import { ImproveDialog, InTheWorks } from "./BriefImprove";
import { ABOUT_YOU, BriefInsights } from "./BriefInsights";
import { HomeSources } from "./HomeSources";
import { BriefSky } from "./BriefSky";
import { allPicks, currentPick, useSky } from "./sky";
import { useBrief, useBriefActions, type BriefActions } from "./useBrief";
import "./brief.css";

function pickMeta(p: BriefPickView) {
  const a = p.action;
  if (p.state === "done") return ["Done"];
  if (p.state === "gone") return ["No longer open"];
  return [a?.sourceLabel, a ? formatDueWhen(a) : undefined].filter((x): x is string => Boolean(x));
}

/** Shown until the person turns the AI brief on: says plainly what it does and what leaves. */
function TurnOn({ view, actions }: { view: View; actions: BriefActions }) {
  if (view.ai.on) return null;
  if (!view.ai.available)
    return (
      <Banner
        tone="inf"
        action={
          <ButtonLink href="/settings/ai" size="sm" variant="ghost">
            Open AI settings
          </ButtonLink>
        }
      >
        {view.ai.reason}
      </Banner>
    );
  return (
    <ProposedBox label="Let Jarvis write your brief">
      <p className="text-sm text-muted">Written from your open items, calendar and check-ins. Finance and AI-excluded areas are never sent.</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          variant="agent"
          size="sm"
          loading={actions.settings.isPending || actions.build.isPending}
          onClick={() => actions.settings.mutate({ ai: true }, { onSuccess: () => actions.build.mutate({}) })}
        >
          Turn on
        </Button>
        <ButtonLink href="/settings/brief" size="sm" variant="ghost">
          What’s shared
        </ButtonLink>
      </div>
    </ProposedBox>
  );
}

/** Open safety alerts the picks left out. Shown first, always: the model can't write one out of the day. */
function Alerts({ alerts }: { alerts: BriefPickView[] }) {
  if (!alerts.length) return null;
  return (
    <section aria-labelledby="brief-alerts-h">
      <h2 className="brief-h" id="brief-alerts-h">
        Safety
      </h2>
      <ul className="brief-alerts">
        {alerts.map((p) => (
          <li key={p.actionId}>
            <span className="brief-node" aria-hidden="true">
              !
            </span>
            <div className="min-w-0">
              <Link href={p.action?.href ?? "/alerts"} className="brief-pick-title">
                {p.title}
              </Link>
              {p.why ? <p className="brief-why">{p.why}</p> : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The picks as one path through the day. The first one still open is the one to
 * be on now: it opens up with its reason, its first step and the page's one
 * primary action. Finished picks stay on the path, checked.
 */
function Path({ view, actions, fb }: { view: View; actions: BriefActions; fb: (key: string) => BriefFeedbackView | undefined }) {
  const picks = allPicks(view.brief);
  if (!picks.length) return null;
  const current = currentPick(view.brief);
  const heading = current ? "Today" : "Done for today";
  return (
    <section aria-labelledby="brief-path-h">
      <h2 className="brief-h" id="brief-path-h">
        {heading}
      </h2>
      <ol className="brief-path">
        {picks.map((p, i) => {
          const key = `pick:${p.actionId}`;
          const a = p.action;
          const isCurrent = p === current;
          const feedback = <Feedback briefId={view.brief.id} targetKey={key} about={p.title} current={fb(key)} send={actions.sendFeedback} />;
          return (
            <li key={p.actionId} data-state={p.state} data-current={isCurrent || undefined}>
              <span className="brief-node" aria-hidden="true">
                {p.state === "done" ? <CheckIcon className="h-4 w-4" /> : i + 1}
              </span>
              <div className="brief-pick">
                {isCurrent ? <h3 className="brief-pick-title">{a ? <Link href={a.href}>{p.title}</Link> : p.title}</h3> : null}
                {!isCurrent && a ? (
                  <Link href={a.href} className="brief-pick-title">
                    {p.title}
                  </Link>
                ) : null}
                {!isCurrent && !a ? <span className="brief-pick-title">{p.title}</span> : null}
                {p.why && p.state !== "done" ? <p className="brief-why">{p.why}</p> : null}
                {isCurrent && p.step ? (
                  <p className="brief-step">
                    <b>First step</b> {p.step}
                  </p>
                ) : null}
                <p className="brief-meta" data-dynamic>
                  {pickMeta(p).map((m) => (
                    <span key={m}>{m}</span>
                  ))}
                </p>
                {isCurrent ? (
                  <div className="brief-row-actions">
                    {a ? (
                      <ButtonLink href={a.href} variant="primary" size="sm" external={a.external}>
                        {a.primaryAction?.kind === "open" ? a.primaryAction.label : "Open"}
                      </ButtonLink>
                    ) : null}
                    {feedback}
                  </div>
                ) : null}
              </div>
              {isCurrent ? null : feedback}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Shelf({
  id,
  title,
  blocks,
  view,
  actions,
  fb,
}: {
  id: string;
  title: string;
  blocks: BriefBlockView[];
  view: View;
  actions: BriefActions;
  fb: (key: string) => BriefFeedbackView | undefined;
}) {
  if (!blocks.length) return null;
  return (
    <section aria-labelledby={id}>
      <h2 className="brief-h" id={id}>
        {title}
      </h2>
      <div className="brief-grid">
        {blocks.map((b) => (
          <BriefBlock key={b.id} block={b} briefId={view.brief.id} feedback={fb(`block:${b.id}`)} send={actions.sendFeedback} tick={actions.tick} />
        ))}
      </div>
    </section>
  );
}

function BriefSkeleton() {
  return (
    <div aria-hidden="true" className="brief">
      <div className="space-y-3 py-2">
        <Skeleton w={140} h={12} className="block" />
        <Skeleton w="85%" h={30} className="block" />
        <Skeleton w="60%" h={30} className="block" />
        <Skeleton w="70%" h={14} className="block" />
      </div>
      <div className="space-y-2">
        <Skeleton w="70%" h={18} className="block" />
        <Skeleton w="50%" h={12} className="block" />
      </div>
    </div>
  );
}

/**
 * The daily brief. With `home` it is the Home screen (the person turned the AI
 * brief on): it also keeps the sources fresh, says when one is failing, carries
 * Home's "while you were away" and "pick up" strips, and links to the list view.
 */
export function BriefView({ home = false }: { home?: boolean }) {
  const online = useOnline();
  const canWork = useAccess().can("work.use");
  const q = useBrief();
  const actions = useBriefActions();
  const view = q.data;
  const { undo, setUndo, error, setError } = actions;
  const [improving, setImproving] = useState(false);

  // An Undo offer lasts 8 seconds; an error stays until dismissed or replaced.
  useEffect(() => {
    if (!undo) return;
    const t = window.setTimeout(() => setUndo(null), 8000);
    return () => window.clearTimeout(t);
  }, [undo, setUndo]);

  const fb = (key: string) => view?.feedback.find((f) => f.targetKey === key);
  const canBuild = Boolean(view && view.ai.on && view.ai.available && online);
  const blocks = view?.brief.blocks ?? [];
  const { phase } = useSky(view?.timezone);
  const evening = phase === "dusk" || phase === "night";
  const wind = (b: BriefBlockView) => (evening && (b.kind === "reflect" || b.kind === "compass") ? 0 : 1);
  const dayBlocks = blocks.filter((b) => !ABOUT_YOU.includes(b.kind)).sort((a, b) => wind(a) - wind(b));

  return (
    <Page width="medium" className="@container">
      <div data-density="sleek">
        {q.error && !view ? <ErrorNote error={q.error} retry={() => q.refetch()} /> : null}
        {!view && !q.error ? (
          <>
            <h1 className="sr-only">Your brief</h1>
            <span className="sr-only" role="status">
              Loading your brief…
            </span>
            <BriefSkeleton />
          </>
        ) : null}
        {!view && q.error ? <h1 className="sr-only">Your brief</h1> : null}

        {view ? (
          <div className="brief" data-testid="brief">
            <BriefSky view={view} actions={actions} canBuild={canBuild} onImprove={view.improve?.available && online ? () => setImproving(true) : undefined} />
            {home ? <HomeSources /> : null}
            <TurnOn view={view} actions={actions} />
            <Alerts alerts={view.brief.alerts ?? []} />
            <Path view={view} actions={actions} fb={fb} />
            <BriefDeck deck={view.deck ?? []} only={["next"]} actions={actions} />
            <BriefInsights view={view} actions={actions} fb={fb} />
            <BriefDeck deck={view.deck ?? []} only={["initiatives", "coming"]} actions={actions} />
            {view.improve ? <InTheWorks improve={view.improve} /> : null}
            <Shelf id="brief-day-h" title="Your day" blocks={dayBlocks} view={view} actions={actions} fb={fb} />
            {home ? (
              <div className="brief-home-strips">
                <WhileAwayCard />
                {canWork ? <PickUpStrip /> : null}
              </div>
            ) : null}
            {home ? (
              <nav aria-label="Other views of today" className="brief-views">
                <Link href="/home?view=list">List view</Link>
                <Link href="/home/all">All of Home</Link>
              </nav>
            ) : null}
            <div className="brief-foot">
              <span>From {view.brief.basedOn.join(" · ") || "nothing yet"}</span>
              {view.brief.id ? (
                <Feedback briefId={view.brief.id} targetKey="brief" about="today's brief" current={fb("brief")} send={actions.sendFeedback} />
              ) : null}
            </div>
          </div>
        ) : null}

        {improving && view?.improve ? <ImproveDialog improve={view.improve} actions={actions} onClose={() => setImproving(false)} /> : null}

        {error || undo ? (
          <div className="brief-undo">
            {error ? (
              <Toast tone="bad" message={error} action={{ label: "Dismiss", onClick: () => setError(null) }} />
            ) : undo ? (
              <Toast tone="ok" message={undo.message} action={{ label: "Undo", onClick: () => void actions.runUndo(undo.op) }} />
            ) : null}
          </div>
        ) : null}
      </div>
    </Page>
  );
}
