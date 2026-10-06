import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { HttpError } from "@/server/http/errors";
import { ADMIN_CAPABILITY, ALL_CAPABILITIES, defaultCapabilities, MODULES, ROLES, type Role } from "@/lib/modules";

/**
 * Who can do what. A person's capabilities are their role's defaults plus
 * per-person grants/revocations (Settings → People). Admins always have
 * everything. Every API route declares the capability it needs; data that
 * flows to Home, search, widgets, alerts and "Ask about…" is filtered too.
 */
export function asRole(v: string | null | undefined): Role {
  return (ROLES as readonly string[]).includes(v ?? "") ? (v as Role) : "adult";
}

export function capabilitiesFor(userId: string, role: Role): Set<string> {
  if (role === "admin") return new Set([ADMIN_CAPABILITY, ...ALL_CAPABILITIES]);
  const caps = new Set(defaultCapabilities(role));
  const overrides = getDb().select().from(schema.userCapabilities).where(eq(schema.userCapabilities.userId, userId)).all();
  for (const o of overrides) {
    if (o.capability === ADMIN_CAPABILITY) continue; // admin comes only from the role
    if (o.granted) caps.add(o.capability);
    else caps.delete(o.capability);
  }
  return caps;
}

/** Save a person's grants; only differences from their role's defaults are stored. */
export function setCapabilities(userId: string, grants: Record<string, boolean>, role: Role) {
  const defaults = new Set(defaultCapabilities(role));
  getDb().transaction((tx) => {
    for (const [capability, granted] of Object.entries(grants)) {
      if (!ALL_CAPABILITIES.includes(capability)) continue;
      const where = and(eq(schema.userCapabilities.userId, userId), eq(schema.userCapabilities.capability, capability));
      if (defaults.has(capability) === granted) tx.delete(schema.userCapabilities).where(where).run();
      else
        tx.insert(schema.userCapabilities)
          .values({ userId, capability, granted })
          .onConflictDoUpdate({ target: [schema.userCapabilities.userId, schema.userCapabilities.capability], set: { granted } })
          .run();
    }
  });
}

export type Capable = { capabilities: Set<string> };

export function can(user: Capable | null | undefined, capability: string) {
  return Boolean(user?.capabilities.has(capability));
}

export function requireCap(user: Capable, capability: string) {
  if (!can(user, capability)) throw new HttpError(403, "forbidden", "You don't have access to that.");
}

/** Modules a person can see at all, for navigation (web and phone). */
export function visibleModules(user: Capable) {
  return MODULES.filter((m) => can(user, m.viewCapability) || m.capabilities.some((c) => can(user, c.id)));
}
