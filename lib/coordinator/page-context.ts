import { isFinanceAreaLike } from "@/lib/catch-up";

export type PageContext = { label: string; path: string; itemId?: string };
export type ResolvedPage = {
  area?: { id?: string; title: string; systemKey?: string | null; aiPolicy?: string | null } | null;
  item?: { id: string; title: string } | null;
  /** Optional titles between area and selected item. */
  parents?: string[];
};
const labels: Record<string, string> = { home: "Today", areas: "Areas", work: "Areas", decisions: "Needs you", chat: "Chat", "home-control": "House" };
const labelFor = (part: string) => labels[part] ?? part.replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase());
const oneLine = (text: string) => text.replace(/[\r\n\[\]]/g, " ").trim();

/** Pure, deliberately fail-closed for unresolved item ancestry and Finance. */
export function pageContext(pathname: string, search: string | URLSearchParams = "", resolved: ResolvedPage = {}): PageContext | null {
  if (!pathname.startsWith("/") || pathname.startsWith("//")) return null;
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0]?.toLowerCase() === "finance" || (resolved.area && (isFinanceAreaLike(resolved.area) || resolved.area.aiPolicy === "excluded"))) return null;
  const params = new URLSearchParams(search);
  const itemId = parts[0] === "areas" || parts[0] === "work" ? (params.get("item") ?? params.get("node")) : null;
  if (itemId && (!resolved.area || !resolved.item || resolved.item.id !== itemId)) return null;
  // Attach routing state only, never arbitrary search/input text or Finance data.
  const safe = new URLSearchParams();
  for (const key of ["item", "node", "view"]) {
    const value = params.get(key);
    if (value) safe.set(key, value);
  }
  const path = pathname + (safe.size ? `?${safe.toString()}` : "");
  const titles = itemId
    ? ["Areas", resolved.area!.title, ...(resolved.parents ?? []), ...(resolved.item!.id === resolved.area!.id ? [] : [resolved.item!.title])]
    : parts.length
      ? parts.map((p, index) => (index > 0 && parts[0] === "chat" ? "Conversation" : labelFor(p)))
      : ["Today"];
  return { label: titles.map(oneLine).join(" › "), path, ...(itemId ? { itemId } : {}) };
}

export function withPageContext(text: string, context: PageContext | null): string {
  return context ? `[Viewing: ${oneLine(context.label)} — ${oneLine(context.path)}]\n${text}` : text;
}
