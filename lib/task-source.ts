/**
 * Task source + assignment labels and the Skylight "whose tasks" filter.
 * Pure (no server imports) so the UI, adapters and tests share it.
 */

export type AssigneeKind = "mine" | "up_for_grabs" | "other";
export type TaskAssignee = { kind: AssigneeKind; name?: string };

export type SkylightMember = { id: string; name: string; linkedToProfile?: boolean };

export type SkylightAssignmentPrefs = {
  /** Skylight category ids that are "me". Empty = not configured yet. */
  members: string[];
  /** Include unassigned / up-for-grabs chores (default on). */
  includeUpForGrabs: boolean;
  /** Keep other people's chores as read-only context (default off). */
  showOthers: boolean;
};

const UP_FOR_GRABS = /\b(up[\s_-]*for[\s_-]*grabs|anyone|unassigned)\b/i;

/** Parse the stored comma-separated member ids + toggles (integration config strings). */
export function skylightPrefs(config: Record<string, string | undefined>): SkylightAssignmentPrefs {
  const flag = (v: string | undefined, dflt: boolean) => (v == null || v === "" ? dflt : v === "true" || v === "1" || v === "on");
  return {
    members: (config.members ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    includeUpForGrabs: flag(config.includeUpForGrabs, true),
    showOthers: flag(config.showOthers, false),
  };
}

/**
 * Auto-match the Jarvis user to Skylight members by first name (or the email's
 * local part). Returns ids only when exactly one member matches.
 */
export function autoMatchMembers(members: SkylightMember[], user: { name?: string | null; email?: string | null; username?: string | null }): string[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const candidates = new Set<string>();
  const first = (user.name ?? "").trim().split(/\s+/)[0];
  if (first) candidates.add(norm(first));
  if (user.name) candidates.add(norm(user.name));
  if (user.username) candidates.add(norm(user.username));
  const local = (user.email ?? "").split("@")[0];
  if (local) candidates.add(norm(local.split(/[._+-]/)[0] ?? local));
  candidates.delete("");
  const people = members.filter((m) => !UP_FOR_GRABS.test(m.name));
  const hits = people.filter((m) => {
    const n = norm(m.name);
    const nFirst = norm(m.name.trim().split(/\s+/)[0] ?? "");
    return candidates.has(n) || candidates.has(nFirst);
  });
  return hits.length === 1 ? [hits[0]!.id] : [];
}

/** Classify one Skylight chore from its category (assignee) and up_for_grabs flag. */
export function classifySkylightChore(chore: { categoryId?: string | null; upForGrabs?: boolean }, members: SkylightMember[], mine: string[]): TaskAssignee {
  const cat = chore.categoryId ? members.find((m) => m.id === chore.categoryId) : undefined;
  if (chore.upForGrabs || !chore.categoryId || (cat && UP_FOR_GRABS.test(cat.name))) return { kind: "up_for_grabs", name: "Up for grabs" };
  if (mine.includes(chore.categoryId)) return { kind: "mine", name: cat?.name };
  return { kind: "other", name: cat?.name };
}

/** Whether a classified chore is shown under the prefs. Unconfigured = show everything (prompt pending). */
export function keepAssigned(a: TaskAssignee, prefs: SkylightAssignmentPrefs): boolean {
  if (!prefs.members.length) return true;
  if (a.kind === "mine") return true;
  if (a.kind === "up_for_grabs") return prefs.includeUpForGrabs;
  return prefs.showOthers;
}

/** Items that count as "the owner's" for overdue/triage context. */
export function isOwnersTask(a: { assignee?: TaskAssignee }): boolean {
  return !a.assignee || a.assignee.kind !== "other";
}

const SOURCE_NAMES: Record<string, string> = {
  skylight: "Skylight",
  todos: "Tasks",
  daily_compass: "Daily Compass",
  home_assistant: "Home Assistant",
  hermes: "Hermes",
  paperclip: "Paperclip",
  github: "GitHub",
  finance: "Finance",
  jarvis: "Jarvis",
};

/** Compact label for the source chip, e.g. "Skylight · Chores", "Google Tasks · Groceries". */
export function taskSourceLabel(a: { source: string; sourceLabel?: string }): string {
  return a.sourceLabel || SOURCE_NAMES[a.source] || a.source;
}

/** Distinct source labels for a "Source" filter. */
export function sourceFilterOptions(items: { source: string; sourceLabel?: string }[]): string[] {
  return [...new Set(items.map(taskSourceLabel))].sort((a, b) => a.localeCompare(b));
}
