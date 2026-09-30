import "server-only";
import type { ActionSource } from "@/lib/contracts";
import type { SourceAdapter } from "./types";
import { hermesAdapter } from "./hermes/adapter";
import { todosAdapter } from "./todos/adapter";
import { dailyCompassAdapter } from "./daily-compass/adapter";
import { homeAssistantAdapter } from "./home-assistant/adapter";
import { skylightAdapter } from "./skylight/adapter";
import { paperclipAdapter } from "./paperclip/service";

export const ADAPTERS: Record<ActionSource, SourceAdapter> = {
  hermes: hermesAdapter,
  todos: todosAdapter,
  daily_compass: dailyCompassAdapter,
  home_assistant: homeAssistantAdapter,
  skylight: skylightAdapter,
  paperclip: paperclipAdapter,
};

export function getAdapter(source: string): SourceAdapter | undefined {
  return ADAPTERS[source as ActionSource];
}
