/**
 * Sub-agent control from Jarvis (coordinator parity, board 1A). Hermes exposes steer/stop for
 * delegate_task children only to the PARENT agent (`delegate_task action=steer|stop`), so Jarvis
 * sends the parent conversation a one-line command that the coordinator brief
 * (server/work/chat-context.ts) tells it to execute:
 *   - parent run still active → POST /api/hermes/runs/<runId>/steer { input: text }
 *   - parent idle             → POST /api/hermes/sessions/<id>/runs { input: text, idempotencyKey }
 */
const SAFE_ID = /^[\w.:@/-]{1,200}$/;

export function canControl(subagentId: string | null | undefined): subagentId is string {
  return !!subagentId && SAFE_ID.test(subagentId);
}

export function steerText(subagentId: string, message: string): string {
  return `Steer ${subagentId}: ${message.trim().replace(/\s+/g, " ").slice(0, 2000)}`;
}

export function stopText(subagentId: string): string {
  return `Stop ${subagentId}`;
}
