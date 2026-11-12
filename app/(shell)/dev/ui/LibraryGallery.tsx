"use client";

import { useState } from "react";
import {
  AnchoredMenu,
  MenuButton,
  useAnchoredMenu,
  Banner,
  Button,
  ButtonLink,
  ChipButton,
  ChipInput,
  ChipSelect,
  DuePicker,
  EmptyState,
  ErrorNote,
  Field,
  IconButton,
  Input,
  LoadingState,
  MetaPicker,
  Page,
  PageHeader,
  Pill,
  SectionHeader,
  Select,
  SelectPicker,
  StatusPickerDot,
  Tabs,
  TagIcon,
  Textarea,
  Toast,
  CoordinatorGlyph,
} from "@/components/ui";

const STATUS = [
  { value: "todo", label: "To do", dot: <StatusPickerDot status="todo" /> },
  { value: "in_progress", label: "In progress", dot: <StatusPickerDot status="in_progress" /> },
  { value: "blocked", label: "Blocked", dot: <StatusPickerDot status="blocked" /> },
  { value: "done", label: "Done", dot: <StatusPickerDot status="done" /> },
];
const TAGS = ["design", "finance", "house", "kids", "garden", "health", "travel", "admin"];

function Plus() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

/** One block of the gallery: a heading plus the live components (docs/ui-library.md sections). */
function Block({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`ui-${id}`} className="card flex flex-col gap-3 p-3.5" data-testid={`ui-${id}`}>
      <h2 id={`ui-${id}`} className="text-sm font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Anchored menu: the ⋯ trigger, right-click, long press or the Menu key on the card; focus returns on close. */
function MenuDemo() {
  const menu = useAnchoredMenu();
  return (
    <Block id="menus" title="Anchored menu (⋯, right-click, long press, Menu key)">
      <div {...menu.surfaceProps} className="relative flex items-center justify-between gap-2 rounded-lg border border-[var(--bd)] p-3">
        <span className="text-sm">R-12 · Smoke tests on the release branch</span>
        <MenuButton menu={menu} label="Actions for R-12" />
        <AnchoredMenu
          menu={menu}
          label="Actions for R-12"
          items={[
            { label: "R-12 · Working", heading: true },
            { label: "Steer…" },
            { label: "Review D-4 · Rotate the newsletter key before the next send" },
            { label: "Ask to stop…", danger: true },
          ]}
        />
      </div>
    </Block>
  );
}

export function LibraryGallery() {
  const [status, setStatus] = useState("in_progress");
  const [tags, setTags] = useState<string[]>(["design", "house"]);
  const [filter, setFilter] = useState("all");
  const [tab, setTab] = useState("pickers");
  const [title, setTitle] = useState("Renew passports");
  return (
    <Page width="medium">
      <PageHeader title="UI library" subtitle="Canonical components from @/components/ui — docs/ui-library.md" />
      <div className="flex flex-col gap-3">
        <Tabs
          label="Gallery sections"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "pickers", label: "Pickers" },
            { id: "forms", label: "Forms" },
            { id: "states", label: "States", count: 4 },
          ]}
        />
        <Block id="buttons" title="Buttons (one primary per view)">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary">Save</Button>
            <Button>Cancel</Button>
            <Button variant="ghost">Skip</Button>
            <Button variant="danger">Delete</Button>
            <Button variant="agent">Ask agent</Button>
            <Button size="sm" icon={<Plus />}>
              Item
            </Button>
            <Button iconOnly icon={<Plus />}>
              Add item
            </Button>
            <ButtonLink href="/dev/kit" size="sm">
              Design-system kit
            </ButtonLink>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <IconButton label="New item" icon={<Plus />} />
            <IconButton label="Chief of staff" icon={<CoordinatorGlyph />} dot="running" />
            <IconButton label="Coordinator" icon={<CoordinatorGlyph />} dot="waiting" />
            <IconButton label="Last run" icon={<CoordinatorGlyph />} dot="failed" />
            <ChipButton>Clear</ChipButton>
            <ChipButton active>Mine</ChipButton>
          </div>
        </Block>
        <Block id="pickers" title="Inline pickers (popover on desktop, sheet on phones, search above 7)">
          <div className="flex flex-wrap items-center gap-2">
            <SelectPicker label="Status" value={status} options={STATUS} onChange={setStatus} />
            <MetaPicker
              label="Tags"
              buttonLabel="Edit tags"
              button={
                <span className="inline-flex items-center gap-1">
                  <TagIcon /> {tags.length} tags
                </span>
              }
              placeholder="Filter tags"
              multi
              options={TAGS.map((t) => ({ value: t, label: t, checked: tags.includes(t) }))}
              onToggle={(v) => setTags((cur) => (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]))}
            />
            <DuePicker value={null} onSave={() => undefined} />
            <ChipSelect
              aria-label="Filter"
              value={filter}
              active={filter !== "all"}
              onChange={(e) => setFilter(e.target.value)}
              className="w-36 [&>select]:w-full"
            >
              <option value="all">All areas</option>
              <option value="home">Home</option>
            </ChipSelect>
            <ChipInput aria-label="Add tag" placeholder="+ tag" />
          </div>
        </Block>
        <Block id="forms" title="Fields (compact; label above, hint/error below)">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field id="ui-title" label="Title" hint="Shown in lists and search.">
              <Input id="ui-title" value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
            <Field id="ui-due" label="Due" error="Pick a date after today.">
              <Input id="ui-due" type="date" invalid defaultValue="2026-01-02" />
            </Field>
            <Field id="ui-notes" label="Notes">
              <Textarea id="ui-notes" placeholder="Anything the agent should know" />
            </Field>
            <Field id="ui-cadence" label="Cadence" hint="Form select (native underneath).">
              <Select id="ui-cadence" defaultValue="monthly">
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="yearly">Yearly</option>
              </Select>
            </Field>
          </div>
        </Block>
        <Block id="states" title="States (loading, empty, error, banner, toast)">
          <SectionHeader label="Open items" count={0} />
          <EmptyState title="Nothing open" action={<Button size="sm">Add item</Button>}>
            New items land here.
          </EmptyState>
          <LoadingState label="Loading items…" />
          <ErrorNote error={new Error("Couldn't load items.")} retry={() => undefined} />
          <Banner tone="wn">Skylight sign-in expires soon.</Banner>
          <div className="flex flex-wrap gap-2">
            <Pill tone="ok">Done</Pill>
            <Pill tone="wn">Waiting</Pill>
            <Pill tone="ai">Agent</Pill>
            <Pill tone="prop">Proposed</Pill>
          </div>
          <Toast message="Saved" action={{ label: "Undo", onClick: () => undefined }} />
        </Block>
        <MenuDemo />
      </div>
    </Page>
  );
}
