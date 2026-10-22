import { api } from "@/server/http/api";
import type { z } from "zod";
import { widgetUpdateSchema } from "@/lib/work";
import { removeWidget, updateWidget } from "@/server/work/dashboard";

type P = { id: string };
export const PATCH = api<z.infer<typeof widgetUpdateSchema>, P>(({ user, params, body, correlationId }) => updateWidget(user, params.id, body, correlationId), {
  cap: "work.use",
  body: widgetUpdateSchema,
});
export const DELETE = api<undefined, P>(({ user, params, correlationId }) => removeWidget(user, params.id, correlationId), { cap: "work.use" });
