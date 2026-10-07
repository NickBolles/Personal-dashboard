import { z } from "zod";
import { api } from "@/server/http/api";
import { getPreferences, PERSONAL_PREFERENCES, updatePreferences } from "@/server/settings";
import { can } from "@/server/access";
import { HttpError } from "@/server/http/errors";

export const GET = api(({ user }) => getPreferences(user.id));

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
/** Everyone edits their own name, quiet hours, alerts and layout; household settings are admin-only. */
export const PUT = api(
  ({ body, user }) => {
    const household = Object.keys(body).filter((k) => !(PERSONAL_PREFERENCES as readonly string[]).includes(k));
    if (household.length && !can(user, "admin")) throw new HttpError(403, "forbidden", "Only an admin can change household settings.");
    return updatePreferences(body, user.id);
  },
  {
    body: z
      .object({
        displayName: z.string().min(1).max(60),
        timezone: z.string().refine((tz) => {
          try {
            new Intl.DateTimeFormat("en", { timeZone: tz });
            return true;
          } catch {
            return false;
          }
        }, "Unknown timezone"),
        refreshIntervalMinutes: z.number().int().min(1).max(120),
        quietHours: z.object({ enabled: z.boolean(), start: hhmm, end: hhmm }).partial(),
        notificationCategories: z.record(z.string(), z.object({ push: z.boolean() })),
        hermes: z
          .object({ defaultModel: z.string().max(100).optional(), defaultProvider: z.string().max(100).optional(), showToolDetails: z.boolean() })
          .partial(),
        integrationFailureAlertMinutes: z.number().int().min(5).max(1440),
        onboarding: z.object({ completedAt: z.string().nullable(), skippedSteps: z.array(z.string()) }).partial(),
        layout: z
          .object({
            homeSections: z.array(z.object({ id: z.string().max(40), visible: z.boolean() })).max(20),
            dynamicColor: z.boolean(),
            theme: z.enum(["system", "light", "dark"]),
            density: z.enum(["comfortable", "compact"]),
          })
          .partial(),
      })
      .partial(),
  },
);
