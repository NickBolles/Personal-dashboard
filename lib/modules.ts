/**
 * Modules: each tool Jarvis connects to (Hermes, Todos, Skylight, Home
 * Assistant, Finance…) declares the capabilities people can be granted and
 * sensible defaults per role. Navigation, Home sources, search, "Ask about…"
 * context and API checks are all derived from these, on the web and the phone.
 * Client-safe: no server imports.
 */
import type { ActionSource } from "@/lib/contracts";

export const ROLES = ["admin", "adult", "kid", "household"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, { label: string; description: string }> = {
  admin: { label: "Admin", description: "Everything, including connections, people and phones." },
  adult: { label: "Adult", description: "Their own conversations and alerts, plus the household things you grant." },
  kid: { label: "Kid", description: "Household calendar and Skylight. No Hermes." },
  household: { label: "Household tablet", description: "A shared screen: calendar, Skylight and home status. Signs in with a PIN." },
};

export type CapabilityDef = {
  id: string;
  label: string;
  description: string;
  /** granted by default for these roles (admin always has everything) */
  roles: Role[];
};

export type ModuleDef = {
  id: string;
  label: string;
  description: string;
  /** Home/alert sources this module owns */
  sources: ActionSource[];
  /** capability needed to see the module at all */
  viewCapability: string;
  /** capability for its Home cards and alerts, when not viewCapability */
  actionsCapability?: string;
  /** web routes (first is the module's main page) */
  routes: { href: string; label: string }[];
  /** "Ask Hermes about …" snapshot id (server/context.ts) */
  contextSource?: string;
  capabilities: CapabilityDef[];
};

export const MODULES: ModuleDef[] = [
  {
    id: "hermes",
    label: "Hermes",
    description: "Conversations, runs and approvals with your agent.",
    sources: ["hermes"],
    viewCapability: "hermes.chat",
    routes: [{ href: "/chat", label: "Hermes" }],
    capabilities: [
      { id: "hermes.chat", label: "Chat with Hermes", description: "Own private conversations; can share one with the household.", roles: ["adult"] },
      { id: "hermes.approve", label: "Approve Hermes actions", description: "Answer approval requests in their own conversations.", roles: ["adult"] },
      { id: "hermes.brain", label: "Brain", description: "Skills, toolsets and scheduled jobs.", roles: [] },
    ],
  },
  {
    id: "todos",
    label: "Todos",
    description: "The household todo list.",
    sources: ["todos"],
    viewCapability: "todos.view",
    routes: [{ href: "/todos", label: "Todos" }],
    contextSource: "todos",
    capabilities: [
      { id: "todos.view", label: "See todos", description: "", roles: ["adult"] },
      { id: "todos.edit", label: "Complete and snooze todos", description: "", roles: ["adult"] },
    ],
  },
  {
    id: "skylight",
    label: "Skylight",
    description: "Family calendar and chores.",
    sources: ["skylight"],
    viewCapability: "skylight.view",
    routes: [{ href: "/skylight", label: "Skylight" }],
    contextSource: "skylight",
    capabilities: [{ id: "skylight.view", label: "See the family calendar and chores", description: "", roles: ["adult", "kid", "household"] }],
  },
  {
    id: "daily_compass",
    label: "Daily Compass",
    description: "Your evening check-in.",
    sources: ["daily_compass"],
    viewCapability: "daily_compass.use",
    routes: [{ href: "/daily-compass", label: "Daily Compass" }],
    contextSource: "daily_compass",
    capabilities: [{ id: "daily_compass.use", label: "Daily Compass", description: "The admin's personal check-in.", roles: [] }],
  },
  {
    id: "home_assistant",
    label: "Home",
    description: "Doors, locks, lights, cameras and the household calendar from Home Assistant.",
    sources: ["home_assistant"],
    viewCapability: "home_assistant.calendar",
    actionsCapability: "home_assistant.view",
    routes: [{ href: "/home-control", label: "Home" }],
    contextSource: "home_assistant",
    capabilities: [
      { id: "home_assistant.calendar", label: "Household calendar", description: "Calendar events from Home Assistant.", roles: ["adult", "kid", "household"] },
      {
        id: "home_assistant.view",
        label: "See doors, locks, lights and alerts",
        description: "Home state, exceptions and health.",
        roles: ["adult", "household"],
      },
      { id: "home_assistant.cameras", label: "See cameras", description: "Camera snapshots.", roles: ["adult", "household"] },
      { id: "home_assistant.control_lights", label: "Turn lights on and off", description: "", roles: ["adult", "household"] },
      {
        id: "home_assistant.control_doors",
        label: "Lock doors and close the garage",
        description: "Allowlisted lock/garage controls with confirmation.",
        roles: ["adult", "household"],
      },
    ],
  },
  {
    id: "paperclip",
    label: "Initiatives",
    description: "Paperclip initiatives linked to conversations.",
    sources: ["paperclip"],
    viewCapability: "paperclip.view",
    routes: [{ href: "/initiatives", label: "Initiatives" }],
    contextSource: "paperclip",
    capabilities: [
      { id: "paperclip.view", label: "See initiatives", description: "", roles: [] },
      { id: "paperclip.track", label: "Track conversations in Paperclip", description: "", roles: [] },
    ],
  },
  {
    id: "finance",
    label: "Finance",
    description: "Monthly check-in, card payments, reserve, purpose funds and the long-term plan.",
    sources: [],
    viewCapability: "finance.view",
    routes: [{ href: "/finance", label: "Finance" }],
    capabilities: [
      { id: "finance.view", label: "See finances", description: "Balances, check-ins, funds and the plan.", roles: ["adult"] },
      { id: "finance.edit", label: "Edit finances", description: "Refresh, plan actions, mark done, close check-ins, edit the plan.", roles: ["adult"] },
    ],
  },
];

/** Admin-only system capabilities (connections, people, phones, audit). */
export const ADMIN_CAPABILITY = "admin";

export const ALL_CAPABILITIES = MODULES.flatMap((m) => m.capabilities.map((c) => c.id));

export function defaultCapabilities(role: Role): string[] {
  if (role === "admin") return [ADMIN_CAPABILITY, ...ALL_CAPABILITIES];
  return MODULES.flatMap((m) => m.capabilities.filter((c) => c.roles.includes(role)).map((c) => c.id));
}

export function moduleForSource(source: string) {
  return MODULES.find((m) => (m.sources as string[]).includes(source));
}

/** What a source's Home cards and alerts need to be visible. */
export function sourceCapability(source: string): string {
  const m = moduleForSource(source);
  return m ? (m.actionsCapability ?? m.viewCapability) : ADMIN_CAPABILITY;
}

/** What acting on a source's card needs (completing a todo needs edit rights). */
export function actionCapability(source: string, kind: string): string {
  if (source === "todos" && (kind === "complete" || kind === "snooze")) return "todos.edit";
  return sourceCapability(source);
}

export function moduleFor(id: string) {
  return MODULES.find((m) => m.id === id);
}
