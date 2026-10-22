import { api } from "@/server/http/api";
import type { z } from "zod";
import { validationUpdateSchema } from "@/lib/work";
import { deleteValidation, updateValidation } from "@/server/work/store";

type P = { id: string };
export const PATCH = api<z.infer<typeof validationUpdateSchema>, P>(
  ({ user, params, body, correlationId }) => ({ validation: updateValidation(user, params.id, body, correlationId) }),
  { cap: "work.use", body: validationUpdateSchema },
);
export const DELETE = api<undefined, P>(({ user, params, correlationId }) => deleteValidation(user, params.id, correlationId), { cap: "work.use" });
