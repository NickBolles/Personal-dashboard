import { z } from "zod";
import { api } from "@/server/http/api";
import { dismiss } from "@/server/quick-actions";
export const POST = api(({ user, params }) => dismiss(user.id, params.id), { cap: "work.use", body: z.object({}).strict() });
