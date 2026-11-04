import { z } from "zod";

export const quickActionScope = z
  .string()
  .max(500)
  .regex(/^(global|area:[\w-]+|page:\/[^\s?#]*)$/);
export const quickActionInput = z
  .object({
    label: z.string().trim().min(1).max(60),
    prompt: z.string().trim().min(1).max(2000),
    scope: quickActionScope.optional(),
    pinned: z.boolean().optional(),
  })
  .strict();
export const quickActionPatch = quickActionInput.partial();
export type QuickActionInput = z.infer<typeof quickActionInput>;
export type QuickAction = Required<QuickActionInput> & {
  id: string;
  userId: string;
  sortOrder: number;
  status: string;
  source: string;
  createdAt: string;
  updatedAt: string;
};
export type QuickActionContext = { areaTitle?: string; pageLabel?: string; path?: string; areaId?: string };
export const QUICK_ACTION_MANAGE = "jarvis:quick-actions-manage";
export const COORDINATOR_PROMPT = "jarvis:coordinator-prompt";
export function contextualActions(rows: QuickAction[], context: QuickActionContext) {
  return rows
    .filter(
      (r) =>
        r.status === "active" &&
        (r.scope === "global" || r.scope === `area:${context.areaId}` || r.scope === `page:${context.path}`) &&
        (!r.prompt.includes("{area}") || !!context.areaTitle),
    )
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.sortOrder - b.sortOrder);
}
export function fillQuickAction(prompt: string, context: QuickActionContext) {
  return prompt.replaceAll("{area}", context.areaTitle ?? "").replaceAll("{page}", context.pageLabel ?? context.path ?? "this page");
}
