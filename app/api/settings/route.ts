import { z } from "zod";
import { api } from "@/server/http/api";
import { getPreferences, updatePreferences } from "@/server/settings";

export const GET = api(() => getPreferences());

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const PUT = api(({ body }) => updatePreferences(body), {
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
      hermes: z.object({ defaultModel: z.string().max(100).optional(), defaultProvider: z.string().max(100).optional(), showToolDetails: z.boolean() }).partial(),
      integrationFailureAlertMinutes: z.number().int().min(5).max(1440),
      onboarding: z.object({ completedAt: z.string().nullable(), skippedSteps: z.array(z.string()) }).partial(),
    })
    .partial(),
});
