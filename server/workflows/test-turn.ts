import "server-only";
import { z } from "zod";
import type { CurrentUser } from "@/server/auth";
import { runStructured } from "@/integrations/hermes/structured";
import { validateDefinition, type WorkflowDefinition } from "@/lib/workflows/definition";
import { captureInstructions, emptyCapture, validateOps, type CaptureOp } from "@/lib/workflows/runs";
import { validateDraft, WorkflowValidationError } from "./store";

/**
 * "Test a turn" (W3): one sandbox turn against the DRAFT definition. Runs a
 * throwaway structured request on Hermes and returns the reply plus the
 * capture changes the model would propose. Nothing is persisted: no
 * workflow_runs row, no capture, no chat session kept, no audit write.
 */
export const testTurnBody = z.object({ definition: z.unknown(), message: z.string().min(1).max(2000) }).strict();

const turnSchema = z.object({ reply: z.string().max(4000), capture: z.array(z.unknown()).max(40).default([]) });

export type TestTurnResult = {
  sandbox: true;
  reply: string;
  ops: CaptureOp[];
  dropped: { reason: string }[];
};

export async function testTurn(user: CurrentUser, body: z.infer<typeof testTurnBody>): Promise<TestTurnResult> {
  const check = validateDraft(user.id, body.definition);
  if (!check.ok) throw new WorkflowValidationError(check.issues);
  const parsed = validateDefinition(body.definition);
  if (!parsed.ok) throw new WorkflowValidationError(parsed.issues);
  const def: WorkflowDefinition = parsed.definition;
  const task = [
    "SANDBOX TEST TURN for a Jarvis workflow draft. Nothing you answer is saved.",
    `Workflow: ${def.name}`,
    "<instructions>",
    def.instructions,
    "</instructions>",
    captureInstructions(def),
    `Current capture (empty): ${JSON.stringify(emptyCapture(def)).slice(0, 2000)}`,
    "The owner says:",
    "<message>",
    body.message,
    "</message>",
    'Reply with ONE JSON object: {"reply":"what you would say","capture":[…capture ops…]}.',
  ].join("\n");
  const out = await runStructured({
    source: "workflow_test_turn",
    label: "Workflow test turn",
    task,
    schema: turnSchema,
    example: { reply: "Noted.", capture: [{ op: "add", path: "points", value: "…" }] },
    interactive: true,
  });
  const { ops, dropped } = validateOps(def, emptyCapture(def), out.capture);
  return { sandbox: true, reply: out.reply, ops, dropped: dropped.map((d) => ({ reason: (d as { reason?: string }).reason ?? "invalid" })) };
}
