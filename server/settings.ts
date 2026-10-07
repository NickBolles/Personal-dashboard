import "server-only";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db";
import { config } from "@/server/config";
import { HOME_SECTIONS, NOTIFICATION_CATEGORIES, type NotificationCategory } from "@/lib/contracts";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24h)");

const HOME_SECTION_IDS = HOME_SECTIONS.map((s) => s.id) as [string, ...string[]];

/** Home layout and look, shared by the phone app and the web. */
export const layoutSchema = z.object({
  /** order = display order; every known section appears exactly once */
  homeSections: z.array(z.object({ id: z.enum(HOME_SECTION_IDS), visible: z.boolean() })).transform((list) => {
    const seen = new Set<string>();
    const kept = list.filter((s) => !seen.has(s.id) && seen.add(s.id));
    return [...kept, ...HOME_SECTION_IDS.filter((id) => !seen.has(id)).map((id) => ({ id, visible: true }))];
  }),
  /** phone: follow the wallpaper (Material You) instead of Jarvis blue */
  dynamicColor: z.boolean(),
  theme: z.enum(["system", "light", "dark"]),
  density: z.enum(["comfortable", "compact"]),
});

function defaultLayout() {
  return {
    homeSections: HOME_SECTION_IDS.map((id) => ({ id, visible: true })),
    dynamicColor: true,
    theme: "system" as const,
    density: "comfortable" as const,
  };
}

export const preferencesSchema = z.object({
  displayName: z.string().min(1).max(60).default("Nick"),
  timezone: z.string().default(config.timezone),
  refreshIntervalMinutes: z.number().int().min(1).max(120).default(5),
  quietHours: z
    .object({ enabled: z.boolean().default(true), start: hhmm.default("22:00"), end: hhmm.default("07:00") })
    .default({ enabled: true, start: "22:00", end: "07:00" }),
  notificationCategories: z
    .record(z.string(), z.object({ push: z.boolean() }))
    .default(Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c.id, { push: c.defaultPush }])) as Record<string, { push: boolean }>),
  hermes: z
    .object({
      defaultModel: z.string().optional(),
      defaultProvider: z.string().optional(),
      showToolDetails: z.boolean().default(false),
    })
    .default({ showToolDetails: false }),
  integrationFailureAlertMinutes: z
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .default(30),
  onboarding: z
    .object({
      completedAt: z.string().optional(),
      skippedSteps: z.array(z.string()).default([]),
    })
    .default({ skippedSteps: [] }),
  layout: layoutSchema.default(defaultLayout()),
});

export type Preferences = z.infer<typeof preferencesSchema>;

const KEY = "preferences";

/**
 * Personal preferences: each person has their own. The owner's live in the
 * household record (as before people existed); everyone else's in an overlay.
 * Everything else (timezone, Hermes defaults, onboarding…) is household-wide.
 */
export const PERSONAL_PREFERENCES = ["displayName", "quietHours", "notificationCategories", "layout"] as const;
const personalKey = (userId: string) => `preferences:user:${userId}`;

function ownerId() {
  return getDb().select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.role, "admin")).orderBy(asc(schema.users.createdAt)).limit(1).get()
    ?.id;
}

function householdPreferences(): Preferences {
  const row = getDb().select().from(schema.settings).where(eq(schema.settings.key, KEY)).get();
  const parsed = preferencesSchema.safeParse(row ? JSON.parse(row.value) : {});
  return parsed.success ? parsed.data : preferencesSchema.parse({});
}

function usesOverlay(userId: string | undefined): userId is string {
  return Boolean(userId && userId !== ownerId());
}

/** Household preferences, with `userId`'s personal ones when given. */
export function getPreferences(userId?: string): Preferences {
  const household = householdPreferences();
  if (!usesOverlay(userId)) return household;
  const name = getDb().select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, userId)).get()?.name;
  const shared = Object.fromEntries(Object.entries(household).filter(([k]) => !(PERSONAL_PREFERENCES as readonly string[]).includes(k)));
  const parsed = preferencesSchema.safeParse({ ...shared, displayName: name || household.displayName, ...(getSetting<object>(personalKey(userId)) ?? {}) });
  return parsed.success ? parsed.data : preferencesSchema.parse({ ...shared, displayName: name || household.displayName });
}

export type PreferencesPatch = Omit<Partial<Preferences>, "onboarding" | "quietHours" | "hermes" | "layout"> & {
  quietHours?: Partial<Preferences["quietHours"]>;
  layout?: Partial<Preferences["layout"]>;
  hermes?: Partial<Preferences["hermes"]>;
  onboarding?: { completedAt?: string | null; skippedSteps?: string[] };
};

export function updatePreferences(patch: PreferencesPatch, userId?: string): Preferences {
  if (usesOverlay(userId)) {
    const personal: PreferencesPatch = {};
    const household: PreferencesPatch = {};
    for (const [k, v] of Object.entries(patch)) Object.assign((PERSONAL_PREFERENCES as readonly string[]).includes(k) ? personal : household, { [k]: v });
    if (Object.keys(household).length) updatePreferences(household);
    if (Object.keys(personal).length) {
      const merged = mergePreferences(getPreferences(userId), personal);
      setSetting(personalKey(userId), Object.fromEntries(PERSONAL_PREFERENCES.map((k) => [k, merged[k]])));
    }
    return getPreferences(userId);
  }
  const merged = mergePreferences(householdPreferences(), patch);
  const value = JSON.stringify(merged);
  getDb()
    .insert(schema.settings)
    .values({ key: KEY, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date().toISOString() } })
    .run();
  return merged;
}

function mergePreferences(current: Preferences, patch: PreferencesPatch): Preferences {
  const onboarding = { ...current.onboarding, ...(patch.onboarding ?? {}) };
  if (onboarding.completedAt === null) delete onboarding.completedAt;
  const merged = preferencesSchema.parse({
    ...current,
    ...patch,
    quietHours: { ...current.quietHours, ...(patch.quietHours ?? {}) },
    notificationCategories: { ...current.notificationCategories, ...(patch.notificationCategories ?? {}) },
    hermes: { ...current.hermes, ...(patch.hermes ?? {}) },
    layout: { ...current.layout, ...(patch.layout ?? {}) },
    onboarding,
  });
  return merged;
}

export function categoryPushEnabled(prefs: Preferences, category: NotificationCategory) {
  const explicit = prefs.notificationCategories[category];
  if (explicit) return explicit.push;
  return NOTIFICATION_CATEGORIES.find((c) => c.id === category)?.defaultPush ?? false;
}

/** Generic JSON key/value helpers for small internal state (VAPID keys, setup code). */
export function getSetting<T>(key: string): T | undefined {
  const row = getDb().select().from(schema.settings).where(eq(schema.settings.key, key)).get();
  return row ? (JSON.parse(row.value) as T) : undefined;
}

export function setSetting(key: string, value: unknown) {
  const v = JSON.stringify(value);
  getDb()
    .insert(schema.settings)
    .values({ key, value: v })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: v, updatedAt: new Date().toISOString() } })
    .run();
}
