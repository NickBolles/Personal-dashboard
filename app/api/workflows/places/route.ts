import { z } from "zod";
import { api } from "@/server/http/api";
import { listSavedPlaces, savePlace, stripLocationOn } from "@/server/workflows/runs";

export const dynamic = "force-dynamic";

/** Saved places for the Place field matcher (owner's own client only; never AI context). */
export const GET = api(({ user }) => ({ places: listSavedPlaces(user.id), stripLocation: stripLocationOn() }), { cap: "work.use" });

const noUrl = (s: string) => !/[<>]|https?:\/\//i.test(s);
const body = z
  .object({
    label: z.string().trim().min(1).max(80).refine(noUrl),
    addressText: z.string().trim().max(200).refine(noUrl).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    radiusM: z.number().int().min(50).max(5000).optional(),
  })
  .strict();

/** Save a place (coordinates only if the owner saves them and location stripping is off). */
export const POST = api<z.infer<typeof body>>(({ user, body, correlationId }) => savePlace({ userId: user.id, correlationId }, body), {
  cap: "work.use",
  body,
});
