import { z } from "zod";

/** Definitions are validated by lib/workflows/definition (rich issues); the body only bounds the envelope. */
export const definitionBody = z.object({ definition: z.unknown(), changeNote: z.string().max(200).optional() }).strict();
