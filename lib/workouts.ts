import { z } from "zod";

export const FOCUSES = ["legs", "push", "pull", "core"] as const;
export const EQUIPMENT = ["machine", "dumbbell", "bodyweight"] as const;
const name = z.string().trim().min(1).max(160);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T12:00:00Z`);
    return Number.isFinite(d.valueOf()) && d.toISOString().slice(0, 10) === s;
  }, "Use a real calendar date");
const unit = z.enum(["lb", "kg", "unknown"]);
const equipment = z.enum([...EQUIPMENT, "unknown"]);
const numericSet = {
  weight: z.number().finite().min(0).max(2000).optional(),
  reps: z.number().int().min(0).max(1000).optional(),
  seconds: z.number().int().min(0).max(86400).optional(),
  note: z.string().max(2000).optional(),
  side: z.string().max(80).optional(),
};
export const setSchema = z.object({ ...numericSet, done: z.boolean() }).strict();
const recordSchema = z.object({ weight: z.number(), reps: z.number(), date: z.string() });
export const exerciseSchema = z
  .object({
    name,
    equipment,
    unit,
    side: z.string().max(80).optional(),
    sets: z.array(setSchema).min(1).max(30),
    best: z.object({ highest: recordSchema, atLoad: recordSchema.nullable() }).nullable().optional(),
    target: z.object({ weight: z.number(), reps: z.number() }).nullable().optional(),
  })
  .strict();
export const sessionSchema = z
  .object({
    date,
    title: name,
    notes: z.string().max(8000),
    status: z.enum(["active", "completed"]),
    exercises: z.array(exerciseSchema).min(1).max(30),
  })
  .strict()
  .superRefine((s, ctx) => {
    for (const [i, e] of s.exercises.entries())
      for (const [j, set] of e.sets.entries()) {
        if (set.done && e.equipment !== "unknown" && (!(set.reps && set.reps > 0) || (e.equipment !== "bodyweight" && set.weight === undefined))) {
          ctx.addIssue({ code: "custom", path: ["exercises", i, "sets", j], message: "Completed sets need reps and a load (except bodyweight)" });
        }
      }
    if (s.status === "completed" && !s.exercises.some((e) => e.sets.some((v) => v.done)))
      ctx.addIssue({ code: "custom", message: "Complete at least one set before finishing" });
  });
export const optionsSchema = z
  .object({
    focuses: z.array(z.enum(FOCUSES)).min(1).max(4),
    minutes: z.union([z.literal(20), z.literal(35), z.literal(50)]),
    equipment: z.array(z.enum(EQUIPMENT)).min(1).max(3),
    unit: z.enum(["lb", "kg"]),
    neckFriendly: z.boolean().default(true),
  })
  .strict();
export type PlanOptions = z.infer<typeof optionsSchema>;
export type WorkoutSession = z.infer<typeof sessionSchema>;
export type Exercise = z.infer<typeof exerciseSchema>;
export type WorkoutSet = z.infer<typeof setSchema>;
export const saveSchema = z
  .object({ id: z.string().min(8).max(100), requestId: z.string().min(8).max(100), version: z.number().int().min(0), session: sessionSchema })
  .strict();

// Passthrough preserves source provenance; it never drives record equivalence.
const legacyWorkout = z
  .object({
    id: name,
    date,
    title: name,
    type: z.string().max(160),
    notes: z.string().max(8000),
    exercises: z
      .array(
        z
          .object({
            name,
            sets: z
              .array(
                z
                  .object({ ...numericSet, reps: z.number().finite().min(0).max(1000).optional(), seconds: z.number().finite().min(0).max(86400).optional() })
                  .passthrough(),
              )
              .max(100),
          })
          .passthrough(),
      )
      .min(1)
      .max(100),
  })
  .passthrough();
export const importSchema = z
  .object({
    schemaVersion: z.literal(1),
    profile: z.object({ displayName: name, gym: z.string().max(160).optional(), units: unit }).passthrough(),
    liftAliases: z.record(z.string().max(160), z.string().max(160)).optional(),
    workouts: z.array(legacyWorkout).min(1).max(500),
  })
  .passthrough()
  .refine((v) => new Set(v.workouts.map((w) => w.id)).size === v.workouts.length, "Duplicate source workout IDs");
export type WorkoutImport = z.infer<typeof importSchema>;
export type WorkoutRow = {
  id: string;
  version: number;
  session: WorkoutSession;
  source: { workout: WorkoutImport["workouts"][number]; profile: WorkoutImport["profile"]; liftAliases?: WorkoutImport["liftAliases"] } | null;
};

const catalog: { name: string; equipment: (typeof EQUIPMENT)[number]; focus: (typeof FOCUSES)[number]; neckFriendly: boolean }[] = [
  { name: "Leg press", equipment: "machine", focus: "legs", neckFriendly: true },
  { name: "Seated leg curl", equipment: "machine", focus: "legs", neckFriendly: true },
  { name: "Leg extension", equipment: "machine", focus: "legs", neckFriendly: true },
  { name: "Chest press", equipment: "machine", focus: "push", neckFriendly: true },
  { name: "Pec fly", equipment: "machine", focus: "push", neckFriendly: true },
  { name: "Seated bicep curl", equipment: "machine", focus: "pull", neckFriendly: true },
  { name: "Chest-supported row", equipment: "machine", focus: "pull", neckFriendly: true },
  { name: "Shoulder press", equipment: "machine", focus: "push", neckFriendly: false },
  { name: "Dumbbell floor press (per hand)", equipment: "dumbbell", focus: "push", neckFriendly: true },
  { name: "Seated dumbbell curl (per hand)", equipment: "dumbbell", focus: "pull", neckFriendly: true },
  { name: "Goblet box squat (total load)", equipment: "dumbbell", focus: "legs", neckFriendly: true },
  { name: "Sit-to-stand", equipment: "bodyweight", focus: "legs", neckFriendly: true },
  { name: "Wall push-up", equipment: "bodyweight", focus: "push", neckFriendly: true },
  { name: "Supine elbow press", equipment: "bodyweight", focus: "pull", neckFriendly: true },
  { name: "Heel slide", equipment: "bodyweight", focus: "core", neckFriendly: true },
  { name: "Supine march", equipment: "bodyweight", focus: "core", neckFriendly: true },
];

function matchingSets(e: Exercise, history: WorkoutSession[]) {
  if (e.equipment === "unknown" || e.unit === "unknown") return [];
  return history
    .filter((s) => s.status === "completed")
    .flatMap((s) =>
      s.exercises
        .filter((p) => p.name === e.name && p.equipment === e.equipment && p.unit === e.unit && (p.side ?? "") === (e.side ?? ""))
        .flatMap((p) =>
          p.sets
            .filter((v) => v.done && v.weight !== undefined && v.reps && (v.side ?? "") === (e.side ?? "") && !v.note)
            .map((v) => ({ weight: v.weight!, reps: v.reps!, date: s.date })),
        ),
    )
    .sort((a, b) => b.date.localeCompare(a.date));
}
export function comparableBest(e: Exercise, history: WorkoutSession[], load?: number): Exercise["best"] {
  const sets = matchingSets(e, history);
  if (!sets.length) return null;
  return {
    highest: [...sets].sort((a, b) => b.weight - a.weight || b.reps - a.reps)[0],
    atLoad: sets.filter((s) => s.weight === load).sort((a, b) => b.reps - a.reps)[0] ?? null,
  };
}
export function generatePlan(input: PlanOptions, history: WorkoutSession[]): Exercise[] {
  const options = optionsSchema.parse(input);
  const eligible = catalog.filter(
    (e) => options.equipment.includes(e.equipment) && options.focuses.includes(e.focus) && (!options.neckFriendly || e.neckFriendly),
  );
  if (options.focuses.some((focus) => !eligible.some((e) => e.focus === focus))) return [];
  // Round-robin focuses so a multi-focus short session never silently drops a selected area.
  const chosen: typeof catalog = [];
  const count = options.minutes === 20 ? 3 : options.minutes === 35 ? 4 : 6;
  for (let round = 0; chosen.length < Math.max(count, options.focuses.length); round++) {
    const batch = [...new Set(options.focuses)].flatMap((focus) => eligible.filter((e) => e.focus === focus)[round] ?? []);
    if (!batch.length) break;
    chosen.push(...batch);
  }
  return chosen.slice(0, Math.max(count, options.focuses.length)).map((item) => {
    const e: Exercise = { name: item.name, equipment: item.equipment, unit: options.unit, sets: [] };
    const recent = matchingSets(e, history).filter((s) => s.reps >= 6 && s.reps <= 15);
    const latest = recent[0];
    // Working load = lightest qualifying set on the most recent session, not all-time max.
    const weight = latest ? Math.min(...recent.filter((s) => s.date === latest.date).map((s) => s.weight)) : undefined;
    e.best = comparableBest(e, history, weight);
    e.target = e.best?.atLoad && e.best.atLoad.reps < 15 ? { weight: e.best.atLoad.weight, reps: e.best.atLoad.reps + 1 } : null;
    e.sets = Array.from({ length: options.minutes === 20 ? 2 : 3 }, () => ({ ...(weight !== undefined ? { weight } : {}), reps: 8, done: false }));
    return e;
  });
}
