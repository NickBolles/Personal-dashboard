"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Role } from "@/lib/modules";

/**
 * What the signed-in person can use, for hiding buttons and navigation. The
 * server enforces the same capabilities on every API call; this is only so
 * nobody is shown something they can't do.
 */
export type Access = { role: Role; capabilities: string[]; modules: string[] };

const AccessContext = createContext<Access>({ role: "admin", capabilities: [], modules: [] });

export function AccessProvider({ value, children }: { value: Access; children: ReactNode }) {
  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>;
}

export function useAccess() {
  const a = useContext(AccessContext);
  return { ...a, can: (cap: string) => a.capabilities.includes(cap), isAdmin: a.capabilities.includes("admin") };
}
