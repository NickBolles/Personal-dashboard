import { z } from "zod";
import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { ACTION_SOURCES, type ActionSource } from "@/lib/contracts";
import { CATEGORY_PATTERN, categoryLabel, MAX_WEIGHT, MIN_WEIGHT, tunableCategories } from "@/lib/attention";
import { hermesBrief, resetTuning, setCategoryWeight, tuningView } from "@/server/home-tuning";
import { homeSelection, sourceVisible } from "@/server/sources";
import { BUDGET } from "@/server/ranking/attention";
import { can, type Capable } from "@/server/access";

export const dynamic = "force-dynamic";

function categoriesFor(user: Capable) {
  return tunableCategories(ACTION_SOURCES.filter((s) => sourceVisible(user, s)));
}

/** Everything this person has told Home, plus the knobs (Settings → Home priorities). */
export const GET = api(async ({ user }) => {
  const { attention } = await homeSelection(user, { live: false });
  const titles = new Map([...attention.now, ...attention.today, ...attention.upcoming, ...attention.backlog, ...attention.waiting].map((a) => [a.id, a.title]));
  const view = tuningView(user, titles);
  return {
    ...view,
    budget: BUDGET,
    tunable: categoriesFor(user).map((category) => ({ category, label: categoryLabel(category) })),
    // Finance never goes to the AI layer (docs/finance.md): no finance weight, titles or corrections in the brief.
    hermesBrief: can(user, "hermes.chat")
      ? hermesBrief(
          {
            ...view,
            categories: view.categories.filter((c) => c.category !== "source:finance"),
            feedback: view.feedback.filter((f) => f.category !== "source:finance"),
          },
          BUDGET,
        )
      : undefined,
  };
});

const putSchema = z.object({
  category: z.string().regex(CATEGORY_PATTERN),
  weight: z.number().int().min(MIN_WEIGHT).max(MAX_WEIGHT),
});

export const PUT = api<z.infer<typeof putSchema>>(
  ({ body, user }) => {
    if (!categoriesFor(user).includes(body.category)) throw new HttpError(400, "bad_category", "Unknown category");
    setCategoryWeight(user.id, body.category, body.weight);
    return { ok: true };
  },
  { body: putSchema },
);

const deleteSchema = z.object({
  scope: z.enum(["all", "weights", "category", "snoozes", "snooze", "feedback"]),
  /** category for scope=category, item id for scope=snooze */
  target: z.string().min(3).max(300).optional(),
  category: z.string().regex(CATEGORY_PATTERN).optional(),
});

/** Reset some or all tuning. Never touches saved dates or anything in a source. */
export const DELETE = api<z.infer<typeof deleteSchema>>(
  ({ body, user }) => {
    const target = body.scope === "category" ? (body.category ?? body.target) : body.target;
    if ((body.scope === "category" || body.scope === "snooze") && !target) throw new HttpError(400, "missing_target", "Say what to reset");
    if (body.scope === "category" && target && target.startsWith("source:") && !ACTION_SOURCES.includes(target.slice(7) as ActionSource))
      throw new HttpError(400, "bad_category", "Unknown category");
    resetTuning(user.id, body.scope, target);
    return { ok: true };
  },
  { body: deleteSchema },
);
