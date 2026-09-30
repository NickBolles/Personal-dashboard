import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db";
import { config } from "@/server/config";
import { NOTIFICATION_CATEGORIES, type NotificationCategory } from "@/lib/contracts";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24h)");

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
});

export type Preferences = z.infer<typeof preferencesSchema>;

const KEY = "preferences";

export function getPreferences(): Preferences {
  const row = getDb().select().from(schema.settings).where(eq(schema.settings.key, KEY)).get();
  const parsed = preferencesSchema.safeParse(row ? JSON.parse(row.value) : {});
  return parsed.success ? parsed.data : preferencesSchema.parse({});
}

export type PreferencesPatch = Omit<Partial<Preferences>, "onboarding" | "quietHours" | "hermes"> & {
  quietHours?: Partial<Preferences["quietHours"]>;
  hermes?: Partial<Preferences["hermes"]>;
  onboarding?: { completedAt?: string | null; skippedSteps?: string[] };
};

export function updatePreferences(patch: PreferencesPatch): Preferences {
  const current = getPreferences();
  const onboarding = { ...current.onboarding, ...(patch.onboarding ?? {}) };
  if (onboarding.completedAt === null) delete onboarding.completedAt;
  const merged = preferencesSchema.parse({
    ...current,
    ...patch,
    quietHours: { ...current.quietHours, ...(patch.quietHours ?? {}) },
    notificationCategories: { ...current.notificationCategories, ...(patch.notificationCategories ?? {}) },
    hermes: { ...current.hermes, ...(patch.hermes ?? {}) },
    onboarding,
  });
  const value = JSON.stringify(merged);
  getDb()
    .insert(schema.settings)
    .values({ key: KEY, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date().toISOString() } })
    .run();
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
