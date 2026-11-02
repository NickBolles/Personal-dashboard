"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import type { SearchResponse, SearchResult } from "@/lib/search";
import { moduleFor } from "@/lib/modules";
import { cx, Spinner, useToast } from "@/components/ui";
import { BoltIcon, ChevronIcon, SearchIcon } from "@/components/icons";
import { matchCommands, NEW_CHAT_EVENT, useCommands, type Command } from "@/components/navigation/commands";
import { useAccess } from "@/components/access";
import { useAskHermes } from "@/components/chat/useAskHermes";
import { parseSlashCommand } from "@/lib/workflows/palette-args";
import { WORKFLOW_START_EVENT } from "@/components/workflows/events";
import { useComposerTarget } from "@/components/agents/useComposerTarget";
import { ComposerTargetChip } from "@/components/agents/ComposerTargetChip";
import { useModKey } from "@/lib/client/platform";
import { isContainer, type ItemsResponse, type WorkItem } from "@/lib/work";
import {
  actionById,
  candidatesFor,
  confirmText,
  currentArg,
  fillAll,
  fillChip,
  isComplete,
  matchActions,
  prSearchUrl,
  prUrlFor,
  pushRecent,
  rankSuggestions,
  RECENT_KEY,
  type ActionDef,
  type Candidate,
  type Chip,
  type Here,
  type PaletteContext,
  type RecentEntry,
  type Suggestion,
  type TypedMatch,
} from "@/lib/palette";
import { PaletteActionPanel, PaletteChips, type PanelEntry } from "@/components/search/PaletteChips";
import { useTagDirectory } from "@/components/work/ItemMeta";
import { INLINE_OP_EVENT } from "@/components/work/InlineEdit";
import type { UndoOp } from "@/components/work/UndoBar";

/** Any page can open search: window.dispatchEvent(new Event(OPEN_SEARCH_EVENT)). */
export const OPEN_SEARCH_EVENT = "jarvis:search";

const KIND_LABEL: Record<SearchResult["kind"], string> = {
  page: "Page",
  setting: "Settings",
  action: "Card",
  event: "Event",
  conversation: "Conversation",
  device: "Device",
  person: "Person",
  finance: "Finance",
  work: "Areas",
};

const PINS_KEY = "jarvis.sidebar.pins";
/** Sidebar listens for this to re-read its pins. */
export const PINS_EVENT = "jarvis:pins";

function readRecent(): RecentEntry[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? (v as RecentEntry[]).filter((x) => x && typeof x.id === "string" && typeof x.title === "string") : [];
  } catch {
    return [];
  }
}
function remember(entry: Omit<RecentEntry, "at">) {
  const e: RecentEntry = { ...entry, at: Date.now() };
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(pushRecent(readRecent(), e)));
  } catch {
    /* private mode */
  }
}

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Ctrl K / "/" search across everything the person can see: pages, Home cards,
 * calendar events, conversations, home devices, finance items (never amounts)
 * and, for admins, people. It is also the command palette: commands (Go to
 * Today/Inbox/…, Capture to Inbox, Start focused work, Record validation,
 * Continue in conversation) are listed first, filtered by what you type; the
 * command dock's action map runs the same commands. Arrow keys move, Enter
 * opens, Escape closes.
 */
export function SearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const qc = useQueryClient();
  const { toast } = useToast();
  const mod = useModKey();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  // Raycast state: a typed action with its chips, a confirm step for writes, breadcrumb sub-lists, the ⌘K panel.
  const [typed, setTyped] = useState<{ def: ActionDef; chips: Chip[] } | null>(null);
  const [confirm, setConfirm] = useState<{ def: ActionDef; chips: Chip[]; run: () => Promise<void>; text?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [stack, setStack] = useState<{ id: string; title: string }[]>([]);
  const [panel, setPanel] = useState<{ title: string; entries: PanelEntry[] } | null>(null);
  const [panelActive, setPanelActive] = useState(0);
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const confirmBtn = useRef<HTMLButtonElement>(null);
  const restore = useRef<HTMLElement | null>(null);
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listId = useId();
  const panelId = useId();
  // 80 ms: one request per typing pause; react-query aborts the stale one (signal) and keeps the last list on screen.
  const debounced = useDebounced(q.trim(), 80);
  const searching = !typed && !stack.length;
  const res = useQuery({
    queryKey: ["search", debounced],
    queryFn: ({ signal }) => api.get<SearchResponse>(`/api/search?q=${encodeURIComponent(debounced)}`, signal),
    // The empty query (recent chats and items) is prefetched on load, so the palette opens with them at once.
    enabled: (open && searching) || !debounced,
    staleTime: debounced ? 15_000 : 60_000,
    placeholderData: keepPreviousData,
  });
  const { can } = useAccess();
  const canWork = can("work.use");
  // Areas/items for chips and sub-lists: the shared cached list (no Hermes call), only while the palette is open.
  const work = useQuery({
    queryKey: ["work", "items", false],
    queryFn: () => api.get<ItemsResponse>("/api/work/items"),
    enabled: open && canWork,
    staleTime: 30_000,
  });
  const workItems = useMemo(() => (work.data?.items ?? []).filter((i) => !i.archived), [work.data]);
  const byId = useMemo(() => new Map(workItems.map((i) => [i.id, i])), [workItems]);
  const tagDir = useTagDirectory(open && canWork);
  const ctx: PaletteContext = useMemo(() => {
    const areas = workItems.filter((i) => i.parentId === null).map((i) => ({ id: i.id, label: i.title }));
    const items = workItems
      .filter((i) => !isContainer(i) && i.kind !== "conversation")
      .map((i) => ({ id: i.id, label: i.title, detail: byId.get(i.parentId ?? "")?.title }));
    const modes = [...new Set(workItems.map((i) => i.settings?.agentMode).filter((m): m is string => Boolean(m)))];
    const dir = tagDir.data;
    const assignees = dir
      ? [
          ...dir.assignees.agents.map((a) => ({ id: a.ref, label: a.label, detail: "Agent" })),
          ...dir.assignees.people.map((p) => ({ id: p.ref, label: p.label, detail: "Person" })),
        ]
      : [];
    const tags = (dir?.tags ?? []).map((t) => ({ id: t.name, label: `#${t.name}` }));
    return { areas, items, agents: [{ id: "jarvis", label: "Jarvis" }, ...modes.map((m) => ({ id: m, label: m }))], assignees, tags };
  }, [workItems, byId, tagDir.data]);
  // Grouped (Areas, Projects, Items, Chats & notes, People…): groups in order of their best match, rank kept inside each.
  const results = useMemo(() => {
    const list = res.data?.results ?? [];
    // Recent (empty query) and matches never mix: typing hides Recent, clearing hides the last matches.
    if (Boolean(q.trim()) !== Boolean(res.data?.query)) return [];
    const order: string[] = [];
    for (const r of list) if (!order.includes(r.group ?? "")) order.push(r.group ?? "");
    return [...list].sort((a, b) => order.indexOf(a.group ?? "") - order.indexOf(b.group ?? ""));
  }, [res.data, q]);
  const allCommands = useCommands();
  const commands = useMemo(() => matchCommands(allCommands, q.trim()).filter((c) => c.id !== "search"), [allCommands, q]);
  const canAsk = can("hermes.chat");
  // Area-contextual "Ask": inside an area/project/item it asks that area's agent and files the chat there.
  const target = useComposerTarget();
  const asker = useAskHermes();
  // W2: the start form (D7) opens in WorkflowStartHost (AppShell) so it outlives the palette.
  const startWorkflow = (command: string) => {
    window.dispatchEvent(new CustomEvent(WORKFLOW_START_EVENT, { detail: { command: command.trim() } }));
  };
  const node = target.node;
  const nodeItem = node ? byId.get(node.id) : undefined;
  const hereItem = nodeItem && !isContainer(nodeItem) ? nodeItem : undefined;
  const hereArea = node ? byId.get(node.areaId) : undefined;
  const has = { item: Boolean(hereItem), area: Boolean(hereArea) };
  const here: Here = node
    ? { kind: hereItem ? "item" : "area", path: pathname, nodeTitle: node.title, areaTitle: node.areaTitle, isContainer: !hereItem }
    : { kind: pathname.startsWith("/chat") ? "chat" : "page", path: pathname };

  type Row =
    | { kind: "command"; c: Command }
    | { kind: "result"; r: SearchResult }
    | { kind: "ask" }
    | { kind: "workflow"; w: { slug: string; name: string }; rest: string }
    | { kind: "action"; m: TypedMatch }
    | { kind: "sugg"; s: Suggestion }
    | { kind: "recent"; e: RecentEntry }
    | { kind: "browse" }
    | { kind: "node"; item: WorkItem }
    | { kind: "cand"; c: Candidate };
  // Not until we know who answers here: an early ask would land in Miscellaneous on plain Jarvis.
  const canAskNow = canAsk && Boolean(q.trim()) && !target.loading && searching;
  const askRow: Row[] = canAskNow ? [{ kind: "ask" }] : [];
  // Workflows: "/teaching Jake Fry" starts that workflow's filed chat (W1: args prefill, start form in W2).
  const slash = canWork && canAsk ? parseSlashCommand(q) : null;
  const wfList = useQuery({
    queryKey: ["workflows"],
    queryFn: ({ signal }) => api.get<{ workflows: { slug: string; name: string; status: string }[] }>("/api/workflows", signal),
    enabled: open && Boolean(slash),
    staleTime: 30_000,
  });
  const wfRows: Row[] = slash
    ? (wfList.data?.workflows ?? [])
        .filter((w) => w.status === "active" && (slash.rest ? w.slug === slash.slug : w.slug.startsWith(slash.slug)))
        .slice(0, 5)
        .map((w) => ({ kind: "workflow" as const, w, rest: slash.rest }))
    : [];
  const commandRows: Row[] = commands.map((c) => ({ kind: "command" as const, c }));
  const resultRows: Row[] = results.map((r) => ({ kind: "result" as const, r }));
  const matches = canWork && searching ? matchActions(q, has) : [];
  const exactRows: Row[] = matches.filter((m) => m.exact || q.trim().startsWith("/")).map((m) => ({ kind: "action" as const, m }));
  const prefixRows: Row[] = matches.filter((m) => !m.exact && !q.trim().startsWith("/")).map((m) => ({ kind: "action" as const, m }));
  // Enter keeps opening commands and results ("today" ↵, "skylight" ↵); a question (4+ words or "?") asks first.
  // Ctrl/⌘ ↵ always asks. A fully typed action ("new item in home") goes on top.
  const question = /\?\s*$/.test(q) || q.trim().split(/\s+/).length >= 4;
  let rows: Row[];
  const arg = typed ? currentArg(typed.def, typed.chips) : null;
  if (typed) {
    rows = arg && arg.kind !== "text" ? candidatesFor(arg.kind, q, ctx).map((c) => ({ kind: "cand" as const, c })) : [];
  } else if (stack.length) {
    const top = stack[stack.length - 1]!;
    const f = q.trim().toLowerCase();
    rows = workItems
      .filter((i) => i.parentId === (top.id || null) && i.kind !== "conversation" && (!f || i.title.toLowerCase().includes(f)))
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((item) => ({ kind: "node" as const, item }));
  } else if (!q.trim()) {
    const sugg: Row[] = canWork
      ? rankSuggestions(
          here,
          recent.filter((r) => r.action).map((r) => r.action!),
          has,
        ).map((s) => ({ kind: "sugg" as const, s }))
      : [];
    const seen = new Set(results.map((r) => r.href));
    const mine: Row[] = recent
      .filter((e) => !e.action && e.href && !seen.has(e.href))
      .slice(0, 4)
      .map((e) => ({ kind: "recent" as const, e }));
    rows = [...sugg, ...mine, ...resultRows, ...(canWork ? [{ kind: "browse" as const }] : []), ...commandRows];
  } else {
    rows =
      question && !commandRows.length && !exactRows.length && !wfRows.length
        ? [...askRow, ...resultRows, ...prefixRows]
        : [...wfRows, ...exactRows, ...commandRows, ...resultRows, ...prefixRows, ...askRow];
  }

  useEffect(() => {
    if (!open) return;
    restore.current = document.activeElement as HTMLElement | null;
    setQ("");
    setActive(0);
    setTyped(null);
    setConfirm(null);
    setStack([]);
    setPanel(null);
    setRecent(readRecent());
    requestAnimationFrame(() => input.current?.focus());
    return () => restore.current?.focus?.();
  }, [open]);

  if (!open) return null;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["work", "items"] });
    void qc.invalidateQueries({ queryKey: ["search"] });
  };
  const close = () => {
    if (press.current) clearTimeout(press.current);
    onClose();
  };
  const startTyped = (def: ActionDef, rest: string, preset: Chip[] = []) => {
    const filled = preset.length ? { chips: preset, input: rest } : fillAll(def, rest, ctx);
    setTyped({ def, chips: filled.chips });
    setQ(filled.input);
    setActive(0);
    setPanel(null);
    requestAnimationFrame(() => input.current?.focus());
    maybeFinish(def, filled.chips);
  };
  const runAction = (def: ActionDef, chips: Chip[]): (() => Promise<void>) => {
    const v = (i: number) => chips[i]!.value;
    switch (def.id) {
      case "new-item":
        return async () => {
          const { item } = await api.post<{ item: WorkItem }>("/api/work/items", { parentId: v(0).id, kind: "thread", title: v(1).label });
          toast(`Created “${item.title}”`, "ok");
          router.push(`/areas?item=${encodeURIComponent(item.id)}`);
        };
      case "move":
        return async () => {
          await api.post(`/api/work/items/${encodeURIComponent(v(0).id)}/move`, { parentId: v(1).id });
          toast(`Moved to ${v(1).label}`, "ok");
        };
      case "assign":
        return async () => {
          await api.patch(`/api/work/items/${encodeURIComponent(hereArea!.id)}`, { settings: { agentMode: v(0).id === "jarvis" ? null : v(0).id } });
          toast(`${hereArea!.title} → ${v(0).label}`, "ok");
        };
      case "status":
        return async () => {
          await api.patch(`/api/work/items/${encodeURIComponent(hereItem!.id)}`, { status: v(0).id });
          toast(`Status: ${v(0).label}`, "ok");
        };
      case "assign-item":
        return async () => {
          const r = await api.patch<{ op: UndoOp | null }>(`/api/work/items/${encodeURIComponent(hereItem!.id)}`, { assignee: v(0).id });
          if (r.op) window.dispatchEvent(new CustomEvent(INLINE_OP_EVENT, { detail: r.op }));
          toast(`Assigned to ${v(0).label}`, "ok");
          void qc.invalidateQueries({ queryKey: ["work"] });
        };
      case "tag":
        return async () => {
          const cur = byId.get(hereItem!.id)?.tags ?? [];
          const r = await api.patch<{ op: UndoOp | null }>(`/api/work/items/${encodeURIComponent(hereItem!.id)}`, { tags: [...new Set([...cur, v(0).id])] });
          if (r.op) window.dispatchEvent(new CustomEvent(INLINE_OP_EVENT, { detail: r.op }));
          toast(`Tagged ${v(0).label}`, "ok");
          void qc.invalidateQueries({ queryKey: ["work"] });
        };
      case "ask":
        return async () => void asker.ask(v(1).label, { areaId: v(0).id });
      case "open-pr":
        return async () => {
          const n = v(0).id;
          // open synchronously (keeps the user gesture), then point it at the linked PR or GitHub search
          const w = window.open("about:blank", "_blank");
          if (w) w.opener = null;
          let url = prSearchUrl(n);
          try {
            const r = await api.get<{ sections: { options: { id: string; detail?: string }[] }[] }>(`/api/references/github?q=${encodeURIComponent(n)}`);
            url = prUrlFor(
              n,
              r.sections.flatMap((s) => s.options),
            );
          } catch {
            /* fall back to GitHub search */
          }
          if (w) w.location.href = url;
          else window.open(url, "_blank", "noopener");
        };
      case "chat-agent":
        return async () => {
          const area = workItems.find((a) => a.parentId === null && a.settings?.agentMode === v(0).id);
          window.dispatchEvent(new CustomEvent(NEW_CHAT_EVENT, { detail: { areaId: area?.id ?? null } }));
        };
    }
  };
  // All chips filled: writes go to the confirm step (never on the first Enter); reads run.
  const maybeFinish = (def: ActionDef, chips: Chip[]) => {
    if (!isComplete(def, chips)) return;
    const run = runAction(def, chips);
    remember({ id: `action:${def.id}`, title: def.label, action: def.id });
    if (def.write) {
      setConfirm({
        def,
        chips,
        run,
        text: confirmText(def, chips, def.id === "status" || def.id === "assign-item" || def.id === "tag" ? hereItem : def.id === "assign" ? hereArea : null),
      });
      requestAnimationFrame(() => confirmBtn.current?.focus());
    } else {
      close();
      void run().catch((e: Error) => toast(e.message, "danger"));
    }
  };
  const doConfirm = async () => {
    if (!confirm || busy) return;
    setBusy(true);
    try {
      await confirm.run();
      refresh();
      close();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };
  const fill = (pick?: Candidate) => {
    if (!typed) return false;
    const next = fillChip(typed.def, typed.chips, q, ctx, pick);
    if (!next) return false;
    setTyped({ def: typed.def, chips: next.chips });
    setQ(next.input);
    setActive(0);
    maybeFinish(typed.def, next.chips);
    return true;
  };
  const hrefOf = (row: Row | undefined): { href: string; title: string; workId?: string } | null => {
    if (!row) return null;
    if (row.kind === "result") return { href: row.r.href, title: row.r.title, workId: row.r.id.startsWith("work:") ? row.r.id.slice(5) : undefined };
    if (row.kind === "node") return { href: `/areas?item=${encodeURIComponent(row.item.id)}`, title: row.item.title, workId: row.item.id };
    if (row.kind === "recent" && row.e.href) return { href: row.e.href, title: row.e.title };
    return null;
  };
  const go = (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === "action") return startTyped(row.m.def, row.m.rest);
    if (row.kind === "sugg" && row.s.action) {
      const def = actionById(row.s.action);
      // "New item in Home" from an area page: the area chip comes from where you are
      const preset =
        (def.id === "new-item" || def.id === "ask") && hereArea
          ? [{ arg: def.args[0]!, value: { id: hereArea.id, label: hereArea.title } }]
          : def.id === "move" && hereItem
            ? [{ arg: def.args[0]!, value: { id: hereItem.id, label: hereItem.title } }]
            : [];
      return startTyped(def, "", preset);
    }
    if (row.kind === "cand") return void fill(row.c);
    if (row.kind === "browse") {
      setStack([{ id: "", title: "Areas" }]);
      setQ("");
      setActive(0);
      return;
    }
    if (row.kind === "node" && isContainer(row.item) && workItems.some((i) => i.parentId === row.item.id && i.kind !== "conversation")) {
      setStack((s) => [...s, { id: row.item.id, title: row.item.title }]);
      setQ("");
      setActive(0);
      return;
    }
    const link = hrefOf(row);
    close();
    if (row.kind === "command") row.c.run();
    else if (row.kind === "ask") void asker.ask(q, { areaId: target.areaId, context: target.context });
    else if (row.kind === "workflow") startWorkflow(`/${row.w.slug} ${row.rest}`);
    else if (link) {
      remember({ id: link.href, title: link.title, href: link.href });
      router.push(link.href);
    }
  };
  const openPanel = (row: Row | undefined) => {
    const link = hrefOf(row);
    if (!link) return;
    const item = link.workId ? byId.get(link.workId) : undefined;
    const abs = new URL(link.href, window.location.origin).toString();
    const entries: PanelEntry[] = [
      { id: "open", label: "Open", hint: "↵", run: () => go(row) },
      { id: "tab", label: "Open in new tab", run: () => (window.open(abs, "_blank", "noopener"), close()) },
      {
        id: "copy",
        label: "Copy link",
        run: () => {
          void navigator.clipboard?.writeText(abs).then(
            () => toast("Link copied", "ok"),
            () => toast("Couldn't copy the link", "danger"),
          );
          setPanel(null);
        },
      },
    ];
    if (item && item.parentId === null)
      entries.push({
        id: "pin",
        label: "Pin to sidebar",
        run: () => {
          try {
            const pins = JSON.parse(window.localStorage.getItem(PINS_KEY) ?? "[]") as string[];
            if (!pins.includes(item.id)) window.localStorage.setItem(PINS_KEY, JSON.stringify([...pins, item.id].slice(0, 24)));
          } catch {
            /* ignore */
          }
          window.dispatchEvent(new Event(PINS_EVENT));
          toast(`Pinned ${item.title}`, "ok");
          setPanel(null);
        },
      });
    if (item && !isContainer(item)) {
      const move = actionById("move");
      entries.push({ id: "file", label: "File to…", run: () => startTyped(move, "", [{ arg: move.args[0]!, value: { id: item.id, label: item.title } }]) });
    }
    if (item && !item.builtIn)
      entries.push({
        id: "archive",
        label: "Archive",
        run: () => {
          setPanel(null);
          const def = actionById("move");
          setConfirm({
            def,
            chips: [],
            text: `Archive “${item.title}”?`,
            run: async () => {
              await api.patch(`/api/work/items/${encodeURIComponent(item.id)}`, { archived: true });
              toast(`Archived “${item.title}”`, "ok");
            },
          });
          requestAnimationFrame(() => confirmBtn.current?.focus());
        },
      });
    setPanel({ title: link.title, entries });
    setPanelActive(0);
  };
  const newGroup = (i: number) => {
    const r = rows[i];
    const p = rows[i - 1];
    return r?.kind === "result" && (p?.kind !== "result" || p.r.group !== r.r.group);
  };
  const sectionLabel = (i: number): string | null => {
    const r = rows[i];
    const p = rows[i - 1];
    if (r?.kind === "sugg" && p?.kind !== "sugg") return "Suggestions";
    if (r?.kind === "recent" && p?.kind !== "recent") return "Recent";
    return null;
  };
  const primary = confirm
    ? "Confirm"
    : typed
      ? arg && arg.kind !== "text"
        ? `Fill ${arg.name}`
        : "Continue"
      : rows[active]?.kind === "action"
        ? "Start"
        : "Open";
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      e.stopPropagation();
      if (panel) setPanel(null);
      else openPanel(rows[active]);
      return;
    }
    if (panel) {
      if (e.key === "Escape") {
        e.preventDefault();
        setPanel(null);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setPanelActive((i) => Math.min(i + 1, panel.entries.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setPanelActive((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        panel.entries[panelActive]?.run();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (typed) {
        setTyped(null);
        setQ("");
      } else if (stack.length) setStack([]);
      else close();
    } else if (e.key === "Backspace" && !q && (typed || stack.length)) {
      // Backspace on an empty input: drop the last chip, then the action; or go up one sub-list
      e.preventDefault();
      if (typed) setTyped(typed.chips.length ? { def: typed.def, chips: typed.chips.slice(0, -1) } : null);
      else setStack((s) => s.slice(0, -1));
      setActive(0);
    } else if (e.key === "Tab" && !e.shiftKey && (typed || rows[active]?.kind === "action")) {
      e.preventDefault();
      if (typed) fill(rows[active]?.kind === "cand" ? (rows[active] as { c: Candidate }).c : undefined);
      else go(rows[active]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canAskNow) {
      e.preventDefault();
      go({ kind: "ask" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (typed) fill(rows[active]?.kind === "cand" ? (rows[active] as { c: Candidate }).c : undefined);
      else go(rows[active]);
    }
  };
  const longPress = (row: Row) => ({
    onTouchStart: () => {
      if (press.current) clearTimeout(press.current);
      press.current = setTimeout(() => openPanel(row), 500);
    },
    onTouchEnd: () => press.current && clearTimeout(press.current),
    onTouchMove: () => press.current && clearTimeout(press.current),
    onContextMenu: (e: React.MouseEvent) => {
      if (hrefOf(row)) {
        e.preventDefault();
        openPanel(row);
      }
    },
  });

  return (
    <div
      className="palette-backdrop fixed inset-0 z-50 flex items-stretch justify-center bg-black/35 sm:items-start sm:p-3 sm:pt-[8vh]"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className="palette-sheet flex w-full flex-col overflow-hidden bg-surface pb-[var(--kb-inset,0px)] sm:max-h-[80vh] sm:max-w-[620px] sm:rounded-[14px] sm:border sm:border-line sm:pb-0 sm:shadow-[var(--shadow-pop)]"
      >
        {stack.length ? (
          <nav aria-label="Breadcrumb" className="flex items-center gap-1 border-b border-line px-4 py-1.5 text-xs text-muted" data-testid="palette-breadcrumb">
            {stack.map((s, i) => (
              <span key={`${s.id}:${i}`} className="truncate">
                {i ? " › " : ""}
                {s.title}
              </span>
            ))}
            <span className="ml-auto shrink-0">
              <kbd className="kbd">⌫</kbd> up
            </span>
          </nav>
        ) : null}
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-line px-4 py-1.5">
          <SearchIcon className="h-[18px] w-[18px] shrink-0 text-muted" />
          {typed ? <PaletteChips def={typed.def} chips={typed.chips} /> : null}
          <input
            ref={input}
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls={listId}
            aria-activedescendant={panel ? undefined : rows[active] ? `${listId}-${active}` : undefined}
            aria-autocomplete="list"
            aria-label="Search Jarvis"
            placeholder={
              typed
                ? arg
                  ? `${arg.name}…`
                  : ""
                : stack.length
                  ? `Filter ${stack[stack.length - 1]!.title}…`
                  : "Search, or type a command (“new item in”, “today”, “/”)…"
            }
            className="min-h-11 min-w-[8rem] flex-1 bg-transparent text-base outline-none placeholder:text-muted"
            value={q}
            disabled={Boolean(confirm)}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKey}
          />
          {res.isFetching && q.trim() && searching ? <Spinner label="Searching" /> : null}
          {canAsk && !typed ? <ComposerTargetChip target={target} /> : null}
          <button
            type="button"
            onClick={close}
            aria-label="Close search (Esc)"
            className="tap inline-flex shrink-0 items-center justify-center rounded-[8px] px-1.5 hover:bg-surface-2"
          >
            <kbd className="kbd">Esc</kbd>
          </button>
        </div>
        {confirm ? (
          <div className="flex min-w-0 flex-col gap-3 p-4" data-testid="palette-confirm">
            <p className="text-base font-medium break-words">{confirm.text}</p>
            <div className="flex flex-wrap gap-2">
              <button
                ref={confirmBtn}
                type="button"
                disabled={busy}
                onClick={() => void doConfirm()}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setConfirm(null);
                    requestAnimationFrame(() => input.current?.focus());
                  }
                }}
                className="tap min-h-11 rounded-[9px] bg-acb px-4 font-medium text-white sm:min-h-9 dense:min-h-[30px] dense:px-3 dense:text-[0.875rem]"
              >
                {busy ? "Working…" : "Confirm"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirm(null);
                  requestAnimationFrame(() => input.current?.focus());
                }}
                className="tap min-h-11 rounded-[9px] px-4 hover:bg-surface-2 sm:min-h-9 dense:min-h-[30px] dense:px-3 dense:text-[0.875rem]"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <ul id={listId} role="listbox" aria-label="Commands and results" className="min-h-0 flex-1 overflow-y-auto p-1.5 sm:max-h-[60vh] sm:flex-none">
            {rows.map((row, i) => {
              const label = sectionLabel(i);
              return (
                <li
                  key={
                    row.kind === "command"
                      ? `cmd:${row.c.id}`
                      : row.kind === "ask"
                        ? "ask"
                        : row.kind === "workflow"
                          ? `wf:${row.w.slug}`
                          : row.kind === "result"
                            ? row.r.id
                            : row.kind === "action"
                              ? `act:${row.m.def.id}`
                              : row.kind === "sugg"
                                ? row.s.id
                                : row.kind === "recent"
                                  ? `recent:${row.e.id}`
                                  : row.kind === "browse"
                                    ? "browse"
                                    : row.kind === "node"
                                      ? `node:${row.item.id}`
                                      : `cand:${row.c.id}`
                  }
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  data-command={row.kind === "command" ? row.c.id : row.kind === "action" ? `action.${row.m.def.id}` : undefined}
                  data-testid={row.kind === "ask" ? "palette-ask" : row.kind === "workflow" ? "palette-workflow" : undefined}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(row)}
                  {...longPress(row)}
                  className={cx(
                    "flex min-h-11 cursor-pointer select-none items-center gap-3 rounded-[8px] px-2.5 py-1.5 sm:min-h-10 dense:min-h-8",
                    i === active && "bg-accent-soft",
                    // a hairline between command groups, so the group label only needs saying once
                    i > 0 && row.kind === "command" && rows[i - 1]?.kind === "command" && (rows[i - 1] as { c: Command }).c.group !== row.c.group && "mt-1.5",
                    i > 0 && ((row.kind === "result" && newGroup(i)) || label) && "mt-1.5",
                  )}
                >
                  {row.kind === "workflow" ? (
                    <>
                      <span aria-hidden="true" className="w-4 shrink-0 text-center font-mono text-xs text-accent">
                        /
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-medium">Start {row.w.name}</span>
                        {row.rest ? <span className="text-muted">: “{row.rest}”</span> : null}
                      </span>
                      <span className="eyebrow shrink-0">Workflow</span>
                    </>
                  ) : row.kind === "ask" ? (
                    <>
                      <span aria-hidden="true" className="w-4 shrink-0 text-center text-xs text-accent">
                        ✦
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-medium">Ask {target.agent}</span>
                        {target.node ? <span className="text-muted"> · {target.node.title}</span> : null}
                        <span className="text-muted">: “{q.trim()}”</span>
                      </span>
                      <kbd className="kbd shrink-0">{i === 0 ? "↵" : `${mod} ↵`}</kbd>
                    </>
                  ) : row.kind === "command" ? (
                    <>
                      <span aria-hidden="true" className="w-4 shrink-0 text-center font-mono text-xs text-muted">
                        ›
                      </span>
                      <span className="min-w-0 flex-1 truncate font-medium">{row.c.label}</span>
                      {i === 0 || rows[i - 1]?.kind !== "command" || (rows[i - 1] as { c: Command }).c.group !== row.c.group ? (
                        <span className="eyebrow shrink-0">{row.c.group}</span>
                      ) : (
                        <span className="sr-only">{row.c.group}</span>
                      )}
                    </>
                  ) : row.kind === "result" ? (
                    <>
                      <span aria-hidden="true" className="w-4 shrink-0 text-center font-mono text-xs text-muted">
                        ·
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{row.r.title}</span>
                        {row.r.subtitle ? <span className="block truncate text-sm text-muted">{row.r.subtitle}</span> : null}
                      </span>
                      {row.r.group && newGroup(i) ? <span className="eyebrow shrink-0">{row.r.group}</span> : null}
                      <span className={cx("shrink-0 text-xs text-muted", row.r.group && "sr-only")}>
                        {KIND_LABEL[row.r.kind]}
                        {row.r.module !== "jarvis" && moduleFor(row.r.module) ? ` · ${moduleFor(row.r.module)!.label}` : ""}
                      </span>
                    </>
                  ) : (
                    <>
                      <span aria-hidden="true" className="inline-flex w-4 shrink-0 items-center justify-center text-xs text-accent">
                        {row.kind === "action" || row.kind === "sugg" ? (
                          <BoltIcon className="h-4 w-4" />
                        ) : row.kind === "node" || row.kind === "browse" ? (
                          <ChevronIcon className="h-3.5 w-3.5" />
                        ) : (
                          "·"
                        )}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {row.kind === "action"
                          ? `${row.m.def.label}${row.m.rest ? ` ${row.m.rest}` : ""}`
                          : row.kind === "sugg"
                            ? row.s.label
                            : row.kind === "recent"
                              ? row.e.title
                              : row.kind === "browse"
                                ? "Browse areas"
                                : row.kind === "node"
                                  ? row.item.title
                                  : row.c.label}
                        {row.kind === "cand" && row.c.detail ? <span className="font-normal text-muted"> · {row.c.detail}</span> : null}
                      </span>
                      {label ? <span className="eyebrow shrink-0">{label}</span> : null}
                      {row.kind === "action" ? <kbd className="kbd shrink-0">Tab</kbd> : null}
                    </>
                  )}
                </li>
              );
            })}
            {typed && arg?.kind === "text" ? (
              <li role="option" aria-selected="false" aria-disabled="true" className="flex min-h-11 items-center px-2.5 text-sm text-muted">
                Type the {arg.name.toLowerCase()}, then ↵
              </li>
            ) : null}
          </ul>
        )}
        {panel && !confirm ? (
          <PaletteActionPanel title={panel.title} entries={panel.entries} active={panelActive} onActive={setPanelActive} listId={panelId} />
        ) : null}
        <div className="flex items-center gap-3 border-t border-line bg-surface-2 px-4 py-2 text-xs text-muted">
          <span className="flex shrink-0 items-center gap-1" data-testid="palette-footer">
            <kbd className="kbd">↵</kbd> {primary}
          </span>
          <span className="min-w-0 flex-1 truncate" role="status">
            {typed || stack.length || confirm ? null : !q.trim() ? (
              <span className="sr-only">Type to search or filter commands.</span>
            ) : res.isError ? (
              `Search failed: ${(res.error as Error).message}`
            ) : res.data && res.data.query === debounced && debounced === q.trim() && !res.isFetching && !results.length ? (
              `Nothing found for “${debounced}”.`
            ) : res.data?.partial.length ? (
              `${results.length} results. ${res.data.partial.join(", ")} didn't answer in time.`
            ) : results.length ? (
              `${results.length} result${results.length === 1 ? "" : "s"}`
            ) : (
              "Searching…"
            )}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            <kbd className="kbd">{mod}</kbd>
            <kbd className="kbd">K</kbd> Actions
          </span>
        </div>
      </div>
    </div>
  );
}
