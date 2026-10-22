import { api } from "@/server/http/api";
import type { z } from "zod";
import { validationSchema } from "@/lib/work";
import { addValidation } from "@/server/work/store";

export const POST = api<z.infer<typeof validationSchema>, { id: string }>(
  ({ user, params, body, correlationId }) => ({ validation: addValidation(user, params.id, body, correlationId) }),
  { cap: "work.use", body: validationSchema },
);
