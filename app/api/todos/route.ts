import { z } from "zod";
import { api } from "@/server/http/api";
import { createLocalTodo } from "@/integrations/todos/adapter";
import { refreshSource } from "@/server/sources";

export const POST = api(
  async ({ body }) => {
    const id = createLocalTodo(body);
    await refreshSource("todos").catch(() => undefined);
    return { id };
  },
  {
    body: z.object({
      title: z.string().min(1).max(300),
      notes: z.string().max(2000).optional(),
      due: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    }),
  },
);
