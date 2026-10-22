import { api } from "@/server/http/api";
import { validationTemplateSchema } from "@/lib/work";
import { createTemplate, listTemplates } from "@/server/work/store";

export const GET = api(({ user }) => ({ templates: listTemplates(user.id) }), { cap: "work.use" });
export const POST = api(({ user, body, correlationId }) => ({ template: createTemplate(user, body, correlationId) }), {
  cap: "work.use",
  body: validationTemplateSchema,
});
