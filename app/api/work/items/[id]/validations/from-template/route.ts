import { api } from "@/server/http/api";
import type { z } from "zod";
import { fromTemplateSchema } from "@/lib/work";
import { addValidationFromTemplate } from "@/server/work/store";

/** "Add from template": metric, comparator, threshold, unit and due date (today + offset). */
export const POST = api<z.infer<typeof fromTemplateSchema>, { id: string }>(
  ({ user, params, body, correlationId }) => ({ validation: addValidationFromTemplate(user, params.id, body.templateId, correlationId) }),
  { cap: "work.use", body: fromTemplateSchema },
);
