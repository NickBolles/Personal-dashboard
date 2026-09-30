import type { ReactNode } from "react";
import { BellIcon, BrainIcon, CalendarIcon, ChatIcon, CompassIcon, FlagIcon, HomeIcon, HouseIcon, TodoIcon } from "@/components/icons";

export type Dest = { key: string; href: string; label: string; icon: (p: { className?: string }) => ReactNode; match: (p: string) => boolean };

export const PRIMARY: Dest[] = [
  { key: "home", href: "/home", label: "Home", icon: HomeIcon, match: (p) => p === "/home" || p === "/" },
  { key: "chat", href: "/chat", label: "Hermes", icon: ChatIcon, match: (p) => p.startsWith("/chat") },
  { key: "alerts", href: "/alerts", label: "Alerts", icon: BellIcon, match: (p) => p.startsWith("/alerts") },
];

export const DESTINATIONS: Dest[] = [
  { key: "initiatives", href: "/initiatives", label: "Initiatives", icon: FlagIcon, match: (p) => p.startsWith("/initiatives") },
  { key: "todos", href: "/todos", label: "Todos", icon: TodoIcon, match: (p) => p.startsWith("/todos") },
  { key: "skylight", href: "/skylight", label: "Skylight", icon: CalendarIcon, match: (p) => p.startsWith("/skylight") },
  { key: "daily-compass", href: "/daily-compass", label: "Daily Compass", icon: CompassIcon, match: (p) => p.startsWith("/daily-compass") },
  { key: "home-control", href: "/home-control", label: "Home", icon: HouseIcon, match: (p) => p.startsWith("/home-control") },
  { key: "brain", href: "/brain", label: "Brain", icon: BrainIcon, match: (p) => p.startsWith("/brain") },
];
