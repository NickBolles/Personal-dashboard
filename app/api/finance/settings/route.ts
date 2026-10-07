import { z } from "zod";
import { api } from "@/server/http/api";
import { financeSettings, saveFinanceSettings } from "@/server/finance/common";
import { cents } from "@/lib/finance/schemas";

export const GET = api(() => financeSettings(), { cap: "finance.view" });

const schema = z
  .object({
    mode: z.enum(["additive", "max"]),
    horizonDays: z.number().int().min(7).max(120),
    cushion: cents.min(0).nullable(),
    staleHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 14),
  })
  .partial();

export const PUT = api<z.infer<typeof schema>>(({ body, user, correlationId }) => saveFinanceSettings(body, user.id, correlationId), {
  cap: "finance.edit",
  body: schema,
});
