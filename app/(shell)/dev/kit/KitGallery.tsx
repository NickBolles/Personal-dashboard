"use client";

import { useState } from "react";
import {
  AgentCard,
  AgentMark,
  AttentionRow,
  Avatar,
  Banner,
  Button,
  Card,
  Checkbox,
  Chip,
  Dot,
  EmptyState,
  Input,
  Kbd,
  Kpi,
  LockBar,
  Menu,
  Orb,
  Pill,
  ProgressBar,
  ProposedBox,
  Row,
  SectionHeader,
  Segmented,
  Skeleton,
  SpendRing,
  SplitButton,
  StatusCircle,
  Tabs,
  Toast,
  Toggle,
  Tooltip,
  TwoLineRow,
  type Agent,
  type KTone,
} from "@/components/ui/kit";

const TONES: KTone[] = ["neutral", "ok", "wn", "bad", "inf", "ac", "ai", "prop", "outline"];
const AGENTS: Agent[] = ["cos", "mom", "dev", "lab", "jar"];

function Panel({ theme }: { theme: "dark" | "light" }) {
  const [checked, setChecked] = useState(false);
  const [on, setOn] = useState(true);
  const [seg, setSeg] = useState("today");
  const [tab, setTab] = useState("all");
  const [locked, setLocked] = useState(true);
  const [orb, setOrb] = useState(false);
  const t = theme === "dark" ? "Dark" : "Light";
  return (
    <section
      data-theme={theme}
      aria-label={`${t} theme`}
      className="flex flex-col gap-4 rounded-[12px] p-4"
      style={{ background: "var(--s0)", color: "var(--t1)" }}
    >
      <SectionHeader label={`${t} theme`} />
      <SectionHeader label="Buttons" />
      <div className="flex flex-wrap items-center gap-2">
        {theme === "dark" ? <Button variant="primary">Primary</Button> : <Button variant="primary">Save</Button>}
        <Button>Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger">Delete</Button>
        <Button variant="agent">Ask agent</Button>
        <Button size="sm">Small</Button>
        <Button iconOnly icon={<span>+</span>}>{`Add (${t})`}</Button>
        <Button loading>Saving</Button>
        <Button disabled>Disabled</Button>
        <SplitButton
          label="+ New"
          variant="secondary"
          onClick={() => {}}
          menu={[
            { label: "Item", onSelect: () => {} },
            { label: "Chat", hint: "C" },
          ]}
          menuLabel={`New options (${t})`}
        />
      </div>
      <SectionHeader label="Pills, dots, status" />
      <div className="flex flex-wrap items-center gap-2">
        {TONES.map((tone) => (
          <Pill key={tone} tone={tone}>
            {tone}
          </Pill>
        ))}
        <Dot tone="ok" label="Healthy" />
        <Dot tone="ai" live label="Agent live" />
        {(["todo", "prog", "done", "block", "prop"] as const).map((s) => (
          <StatusCircle key={s} status={s} label={s} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {AGENTS.map((a) => (
          <AgentMark key={a} agent={a} />
        ))}
        <Avatar initials="NB" />
        <Chip selected>Selected</Chip>
        <Chip onRemove={() => {}}>Removable</Chip>
        <Kbd>⌘K</Kbd>
        <Tooltip content="Search" kbd="/">
          <Button size="sm">Hover me</Button>
        </Tooltip>
      </div>
      <SectionHeader label="Controls" />
      <div className="flex flex-wrap items-center gap-4">
        <Checkbox checked={checked} onChange={setChecked} label={`Done (${t})`} celebrate />
        <Toggle checked={on} onChange={setOn} label={`Notify (${t})`} />
        <Toggle checked={false} onChange={() => {}} label={`Spend cap (${t})`} locked />
        <Segmented
          label={`Range (${t})`}
          value={seg}
          onChange={setSeg}
          options={[
            { value: "today", label: "Today" },
            { value: "week", label: "Week", count: 4 },
          ]}
        />
      </div>
      <Tabs
        label={`Filter (${t})`}
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "all", label: "All", count: 12 },
          { id: "mine", label: "Mine" },
        ]}
      />
      <Input placeholder="Search…" aria-label={`Search (${t})`} />
      <Input placeholder="Invalid" aria-label={`Invalid (${t})`} invalid />
      <ProgressBar value={60} label="Progress" />
      <ProgressBar value={35} tone="orb" label="Agent progress" />
      <Skeleton h={14} />
      <Menu
        label={`Actions (${t})`}
        items={[
          { label: "Group", heading: true },
          { label: "Rename", hint: "R" },
          { label: "Delete", danger: true },
        ]}
      />
      <Toast message="Item archived" action={{ label: "Undo", onClick: () => {} }} />
      <SectionHeader label="Rows and cards" count={3} />
      <Card title="Card" meta="meta" actions={<Button size="sm">Act</Button>}>
        <Row leading={<StatusCircle status="todo" label="To do" />} title="One-line row" meta="2d" onClick={() => {}} />
        <Row title="Selected row" selected />
        <TwoLineRow leading={<AgentMark agent="dev" size="sm" />} title="Two-line row" sub="Subtitle text" current />
      </Card>
      <AttentionRow tone="wn" icon="!" title="Bill due tomorrow" why="Electric · $84" actions={<Button size="sm">Pay</Button>} />
      <AttentionRow
        agent="cos"
        title="Move dentist to Friday"
        why="Conflicts with standup"
        proposed
        actions={
          <Button size="sm" variant="agent">
            Apply
          </Button>
        }
      />
      <ProposedBox>Draft reply staged by Chief of staff.</ProposedBox>
      <Banner tone="wn">Hermes is slow to answer.</Banner>
      <Banner tone="bad">Sync failed.</Banner>
      <EmptyState title="Nothing here">You&apos;re all caught up.</EmptyState>
      <div className="grid grid-cols-2 gap-2">
        <Kpi label="Left today" value="4" tone="ac" />
        <Kpi label="From agents" value="2" tone="ai" delta="+1 since 9am" />
      </div>
      <LockBar locked={locked} onUnlock={() => setLocked(false)} />
      <div className="flex items-center gap-4">
        <Orb expanded={orb} onClick={() => setOrb((o) => !o)} label={`Jarvis commands (${t})`} />
        <SpendRing spent={3.2} budget={10} />
      </div>
      <AgentCard agent="cos" title="Chief of staff" status="Working" live actions={<Button size="sm">Open</Button>}>
        Triaging 6 inbox items.
      </AgentCard>
    </section>
  );
}

export function KitGallery() {
  return (
    <div className="mx-auto w-full max-w-6xl p-4">
      <h1 className="mb-4 text-xl font-semibold">Component kit</h1>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel theme="dark" />
        <Panel theme="light" />
      </div>
    </div>
  );
}
