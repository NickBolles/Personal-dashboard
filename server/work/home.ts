import "server-only";
import type { NextAction } from "@/lib/contracts";
import type { AdapterContext } from "@/integrations/types";
import { itemsWithValidations } from "./store";
import { workHomeActions } from "./home-rules";

/** This person's Work cards for Home (visible, unarchived items only). Callers check work.use. */
export function workHomeActionsFor(userId: string, ctx: AdapterContext): NextAction[] {
  const { rows, vals } = itemsWithValidations(userId);
  return workHomeActions(rows, vals, ctx);
}
