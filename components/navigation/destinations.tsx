import type { ReactNode } from "react";
import {
  AreasIcon,
  BellIcon,
  BrainIcon,
  CalendarIcon,
  ChatIcon,
  CompassIcon,
  DumbbellIcon,
  FlagIcon,
  HomeIcon,
  HouseIcon,
  TodoIcon,
  WalletIcon,
} from "@/components/icons";

export type Dest = {
  key: string;
  href: string;
  label: string;
  icon: (p: { className?: string }) => ReactNode;
  match: (p: string) => boolean;
  /** shown only to people holding one of these capabilities (lib/modules.ts) */
  caps?: string[];
  /** hidden from people holding any of these (a richer destination replaces it) */
  hideWithCaps?: string[];
};

const isAreas = (p: string) => p === "/areas" || p.startsWith("/areas/") || p === "/work" || p.startsWith("/work/");

/**
 * Primary destinations. Areas is one tree for work and conversations (phase 4):
 * people who organize work get Areas (which includes the conversations
 * view); everyone else who chats keeps the plain Hermes list.
 */
export const PRIMARY: Dest[] = [
  { key: "home", href: "/home", label: "Home", icon: HomeIcon, match: (p) => p === "/home" || p === "/" },
  {
    key: "areas",
    href: "/areas",
    label: "Areas",
    icon: AreasIcon,
    match: (p) => isAreas(p) || p.startsWith("/chat"),
    caps: ["work.use"],
  },
  { key: "chat", href: "/chat", label: "Hermes", icon: ChatIcon, match: (p) => p.startsWith("/chat"), caps: ["hermes.chat"], hideWithCaps: ["work.use"] },
  { key: "alerts", href: "/alerts", label: "Alerts", icon: BellIcon, match: (p) => p.startsWith("/alerts") },
];

export const DESTINATIONS: Dest[] = [
  {
    key: "workouts",
    href: "/workouts",
    label: "Workouts",
    icon: DumbbellIcon,
    match: (p) => p === "/workouts" || p.startsWith("/workouts/"),
    caps: ["workouts.use"],
  },
  { key: "finance", href: "/finance", label: "Finance", icon: WalletIcon, match: (p) => p.startsWith("/finance"), caps: ["finance.view"] },
  { key: "initiatives", href: "/initiatives", label: "Initiatives", icon: FlagIcon, match: (p) => p.startsWith("/initiatives"), caps: ["paperclip.view"] },
  { key: "todos", href: "/todos", label: "Todos", icon: TodoIcon, match: (p) => p.startsWith("/todos"), caps: ["todos.view"] },
  { key: "skylight", href: "/skylight", label: "Skylight", icon: CalendarIcon, match: (p) => p.startsWith("/skylight"), caps: ["skylight.view"] },
  {
    key: "daily-compass",
    href: "/daily-compass",
    label: "Daily Compass",
    icon: CompassIcon,
    match: (p) => p.startsWith("/daily-compass"),
    caps: ["daily_compass.use"],
  },
  {
    // "House", not a second "Home" (design review D2).
    key: "home-control",
    href: "/home-control",
    label: "House",
    icon: HouseIcon,
    match: (p) => p.startsWith("/home-control"),
    caps: ["home_assistant.view", "home_assistant.calendar"],
  },
  { key: "brain", href: "/brain", label: "Brain", icon: BrainIcon, match: (p) => p.startsWith("/brain"), caps: ["hermes.brain"] },
];

export function allowed(d: Dest, capabilities: string[]) {
  if (d.hideWithCaps?.some((c) => capabilities.includes(c))) return false;
  return !d.caps || d.caps.some((c) => capabilities.includes(c));
}
