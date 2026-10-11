import { z } from "zod";
import { api } from "@/server/http/api";
import { addMilestone, listMilestones } from "@/server/home-tuning";

const isRealDate = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

const bodySchema = z.object({
  title: z.string().trim().min(1).max(80),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isRealDate, "Not a real date"),
  yearly: z.boolean(),
  leadDays: z.number().int().min(7).max(180),
});

/** Saved dates for "plan ahead" suggestions. Private to the person who saved them. */
export const GET = api(({ user }) => ({ milestones: listMilestones(user.id) }));

export const POST = api<z.infer<typeof bodySchema>>(({ body, user }) => ({ id: addMilestone(user.id, body) }), { body: bodySchema });
