import { api } from "@/server/http/api";
import { widgetCreateSchema } from "@/lib/work";
import { addWidget } from "@/server/work/dashboard";

export const POST = api(({ user, body, correlationId }) => addWidget(user, body, correlationId), { cap: "work.use", body: widgetCreateSchema });
