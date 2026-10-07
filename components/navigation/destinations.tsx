import type { ReactNode } from "react";
import { BellIcon, BrainIcon, CalendarIcon, ChatIcon, CompassIcon, FlagIcon, HomeIcon, HouseIcon, TodoIcon, WalletIcon } from "@/components/icons";

export type Dest = {
  key: string;
  href: string;
  label: string;
  icon: (p: { className?: string }) => ReactNode;
  match: (p: string) => boolean;
  /** shown only to people holding one of these capabilities (lib/modules.ts) */
  caps?: string[];
};

export const PRIMARY: Dest[] = [
  { key: "home", href: "/home", label: "Home", icon: HomeIcon, match: (p) => p === "/home" || p === "/" },
  { key: "chat", href: "/chat", label: "Hermes", icon: ChatIcon, match: (p) => p.startsWith("/chat"), caps: ["hermes.chat"] },
  { key: "alerts", href: "/alerts", label: "Alerts", icon: BellIcon, match: (p) => p.startsWith("/alerts") },
];

export const DESTINATIONS: Dest[] = [
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
    key: "home-control",
    href: "/home-control",
    label: "Home",
    icon: HouseIcon,
    match: (p) => p.startsWith("/home-control"),
    caps: ["home_assistant.view", "home_assistant.calendar"],
  },
  { key: "brain", href: "/brain", label: "Brain", icon: BrainIcon, match: (p) => p.startsWith("/brain"), caps: ["hermes.brain"] },
];

export function allowed(d: Dest, capabilities: string[]) {
  return !d.caps || d.caps.some((c) => capabilities.includes(c));
}
