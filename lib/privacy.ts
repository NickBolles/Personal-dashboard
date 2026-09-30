import type { ActionSource } from "@/lib/contracts";

/**
 * Sources whose data never goes to the AI layer (Hermes), in any form: home
 * state (locks, alarm, garage, covers, presence), entity IDs and names.
 * See docs/security.md → "What never reaches Hermes".
 */
export const NEVER_SHARED_WITH_HERMES: readonly ActionSource[] = ["home_assistant"];

export function shareableWithHermes(source: string) {
  return !(NEVER_SHARED_WITH_HERMES as readonly string[]).includes(source);
}
