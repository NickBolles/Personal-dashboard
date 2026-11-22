import "server-only";
import { z } from "zod";
import { agentProfileSchema } from "@/lib/agent-access";
import { HttpError } from "@/server/http/errors";
import { startTask, steerTask, type TaskCaller } from "@/server/work/task-runs";
import { writeSuggestion } from "@/server/work/suggestions";
import { areaIndex } from "@/lib/map-rollup";
import { agentItems, visible, type ToolDef } from "./tools";

// Local generic helper avoids evaluating the tools.ts registry during its own initialization.
const tool = <S extends z.ZodType>(t: ToolDef<S>) => t as unknown as ToolDef;
const id = z.string().trim().min(1).max(64);

/**
 * The three things a bot does with a task (task threads, step 2; docs/agent-tools.md "Tasks"): start it, steer it,
 * hand it off. Work never happens in the bot's own channel chat: these open or continue the TASK's chat, so the
 * owner has one place to look. All three need the `tasks.run` scope, which the owner grants per token.
 */
export const TASK_TOOLS: ToolDef[] = [
  tool({
    name: "jarvis_start_task",
    description:
      "Start work on a task: opens the task's own chat with your brief, on the agent that works on it (its assignee, else the agent of its area, else the Chief of staff), and registers the run there. Use this instead of doing the work in your own conversation. Create the task first with jarvis_create_item if it does not exist. Refused while the task's chat already has a run in flight (steer it instead). Returns {itemId, runId, ref, sessionId, worker, href, undoOpId}; in your reply, link the task by its href and do not repeat the brief.",
    scope: "tasks.run",
    input: z
      .object({
        itemId: id,
        brief: z.string().trim().min(1).max(8000),
        title: z.string().trim().min(1).max(200).optional(),
      })
      .strict(),
    run: ({ itemId, brief, title }, { agent, correlationId }) => startTask(caller(agent), visible(agent.user.id, itemId), { brief, title }, correlationId),
  }),
  tool({
    name: "jarvis_steer_task",
    description:
      "Tell a task's agent something, in the task's chat: guidance for the run in flight, or the next message when nothing is running. ownerAsked must be true, and only when the owner asked for this steer in the conversation you are in. A steer that is your own idea is a proposal: suggest it with jarvis_suggest (act \"steer\") and the owner sends it. Returns {itemId, sessionId, delivered: guidance|message, href}.",
    scope: "tasks.run",
    input: z
      .object({
        itemId: id,
        message: z.string().trim().min(1).max(4000),
        ownerAsked: z.boolean(),
      })
      .strict(),
    run: ({ itemId, message, ownerAsked }, { agent, correlationId }) => {
      const item = visible(agent.user.id, itemId);
      if (!ownerAsked)
        throw new HttpError(
          403,
          "owner_only",
          'A steer you thought of yourself is a proposal, not a message: suggest it with jarvis_suggest (act "steer") and the owner decides whether it is sent',
        );
      return steerTask(caller(agent), item, { message }, correlationId);
    },
  }),
  tool({
    name: "jarvis_hand_off",
    description:
      "Hand a task to another agent: assigns it to toProfile and starts it in a chat with that agent, with your brief. If the task's chat is with a different agent, a new chat with toProfile becomes the task's chat and the old one is kept under Other chats. The owner can undo it (the run is stopped, the assignee and the chat go back). Returns the same as jarvis_start_task.",
    scope: "tasks.run",
    input: z
      .object({
        itemId: id,
        toProfile: agentProfileSchema,
        brief: z.string().trim().min(1).max(8000),
        title: z.string().trim().min(1).max(200).optional(),
      })
      .strict(),
    run: ({ itemId, toProfile, brief, title }, { agent, correlationId }) =>
      startTask(caller(agent), visible(agent.user.id, itemId), { brief, title, toProfile }, correlationId),
  }),
  tool({
    name: "jarvis_suggest",
    description:
      'Suggest a next step to the owner, as a card they may Start or Send (it is never done by itself). act "start": start a task (itemId), or a new task titled `title` when itemId is left out. act "steer": tell a working task (itemId) something. why is one line from the owner\'s own work (counts, dates, task names); evidence lists the itemIds of the tasks it comes from (at least one, all in one channel); text is exactly what the agent will be told; topic is a short kind such as "review" or "follow_up". Refused for Finance, a channel closed to AI, a kind the owner turned off, or a repeat. Returns {suggestionId, channelId, title, act}.',
    scope: "decisions.write",
    input: z
      .object({
        act: z.enum(["start", "steer"]),
        itemId: id.optional(),
        title: z.string().trim().min(1).max(200),
        why: z.string().trim().min(1).max(300),
        text: z.string().trim().min(1).max(4000),
        evidence: z.array(id).min(1).max(5),
        topic: z
          .string()
          .trim()
          .regex(/^[a-z][a-z_]{1,39}$/)
          .optional(),
      })
      .strict(),
    run: (input, { agent }) => {
      const channelId = channelOfItem(agent.user.id, input.itemId ?? input.evidence[0]!);
      if (!channelId) throw new HttpError(409, "refused", "Suggestions are only for tasks in a channel open to AI");
      const written = writeSuggestion(agent.user, channelId, agent.profile, input, null);
      if (!written.ok) throw new HttpError(409, "refused", `Not suggested: ${written.reason}`);
      return { suggestionId: written.id, channelId, title: input.title, act: input.act };
    },
  }),
];

/** The top-level area (channel) a visible item sits in. */
function channelOfItem(userId: string, itemId: string): string | null {
  const { items, byId } = agentItems(userId);
  if (!byId.has(itemId)) return null;
  return areaIndex(items).get(itemId) ?? null;
}

function caller(agent: { user: TaskCaller["user"]; profile: string; tokenId: string }): TaskCaller {
  return { user: agent.user, profile: agent.profile, tokenId: agent.tokenId };
}
