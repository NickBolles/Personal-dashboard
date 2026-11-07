/**
 * Name-based "is this the Finance area?" check for NON-AI product rules (the
 * portfolio import/view keep Finance out of agent-built boards). Since the
 * owner's 2026-11-07 decision it no longer decides anything about AI: use the
 * per-area `aiPolicy` (Exclude from AI) for that.
 */
export function isFinanceAreaLike(area: { title: string; systemKey?: string | null }) {
  const key = (area.systemKey ?? "").toLowerCase();
  const title = area.title.trim().toLowerCase();
  return key === "finance" || title === "finance" || title === "finances" || /^financ(e|es|ial)\b/.test(title);
}
