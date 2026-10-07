import type { Role } from "@/lib/modules";

/** A household member as Settings → People shows them. */
export type Person = {
  id: string;
  name: string;
  username?: string;
  role: Role;
  /** set up this Jarvis; can't be removed */
  owner: boolean;
  disabled: boolean;
  hasPasscode: boolean;
  /** an unused invite is waiting */
  inviteExpiresAt?: string;
  /** effective capabilities (role defaults + overrides) */
  capabilities: string[];
  /** per-person differences from the role's defaults */
  overrides: Record<string, boolean>;
  phones: number;
  createdAt: string;
};

/** GET /api/auth/me */
export type Me = {
  user: { id: string; name: string; username?: string; role: Role; via: "session" | "proxy" | "device" };
  capabilities: string[];
  /** module ids this person can open, in navigation order */
  modules: string[];
  authMode: "local" | "proxy";
  onboarded: boolean;
};
